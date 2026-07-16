/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { createServer } from 'net';
import { homedir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { ILogService } from '../../log/common/log.js';
import { ILucosDaemonEndpoint } from './lucosGrpcClient.js';

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_POLL_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 3_000;

export interface ILucosDaemonJson {
	readonly pid?: number;
	readonly port?: number;
	readonly grpc_port?: number;
	readonly token?: string;
	readonly session_token?: string;
	readonly local_session_token?: string;
}

export interface ILucosDaemonProcessManagerOptions {
	readonly resolveBinary: () => string | undefined;
	readonly gatewayUrl?: string;
	/** Returns true when the daemon at the endpoint answers a healthy Health RPC. */
	readonly isHealthy: (endpoint: ILucosDaemonEndpoint) => Promise<boolean>;
	readonly dataDir?: string;
	readonly pollIntervalMs?: number;
	readonly pollTimeoutMs?: number;
	/** Injected for tests. */
	readonly spawnFn?: typeof spawn;
	readonly allocateHttpPort?: () => Promise<number>;
}

/**
 * Ensures a Lucos local-daemon is reachable for the IDE:
 * adopt an existing healthy process, otherwise spawn the bundled binary.
 * Only the child this manager spawned is stopped on shutdown.
 */
export class LucosDaemonProcessManager extends Disposable {

	private ownedChild: ChildProcess | undefined;
	private ownedPid: number | undefined;
	private readonly spawnFn: typeof spawn;
	private readonly allocateHttpPort: () => Promise<number>;
	private readonly dataDir: string;
	private readonly pollIntervalMs: number;
	private readonly pollTimeoutMs: number;

	constructor(
		private readonly logService: ILogService,
		private readonly options: ILucosDaemonProcessManagerOptions,
	) {
		super();
		this.spawnFn = options.spawnFn ?? spawn;
		this.allocateHttpPort = options.allocateHttpPort ?? allocateEphemeralLoopbackPort;
		this.dataDir = options.dataDir ?? join(homedir(), '.lucos');
		this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
		this.pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
		this._register({
			dispose: () => {
				// Sync dispose path: best-effort kill without awaiting.
				if (this.ownedChild && !this.ownedChild.killed) {
					try { this.ownedChild.kill('SIGTERM'); } catch { /* ignore */ }
				}
			}
		});
	}

	get ownsDaemon(): boolean {
		return typeof this.ownedPid === 'number';
	}

	async ensureRunning(): Promise<ILucosDaemonEndpoint | undefined> {
		const existing = this.readEndpoint();
		if (existing) {
			if (await this.safeHealthy(existing)) {
				this.logService.info('[lucosDaemon] Adopting existing healthy daemon', existing.address);
				return existing;
			}
			this.logService.info('[lucosDaemon] Existing daemon.json is stale or unhealthy; will spawn if possible');
		}

		const binary = this.options.resolveBinary();
		if (!binary) {
			this.logService.info('[lucosDaemon] No bundled daemon binary (dev build or missing package); skipping spawn');
			return existing;
		}

		await this.spawnDaemon(binary);
		const endpoint = await this.waitForEndpoint();
		if (!endpoint) {
			this.logService.error('[lucosDaemon] Timed out waiting for daemon.json after spawn');
			return undefined;
		}
		return endpoint;
	}

	async stopOwnedDaemon(): Promise<void> {
		const child = this.ownedChild;
		const pid = this.ownedPid;
		this.ownedChild = undefined;
		this.ownedPid = undefined;
		if (!child && !pid) {
			return;
		}

		this.logService.info('[lucosDaemon] Stopping owned daemon', String(pid ?? child?.pid));
		await new Promise<void>(resolve => {
			let settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};

			const timer = setTimeout(() => {
				try { child?.kill('SIGKILL'); } catch { /* ignore */ }
				if (typeof pid === 'number') {
					try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
				}
				done();
			}, STOP_GRACE_MS);

			if (child) {
				child.once('exit', () => {
					clearTimeout(timer);
					done();
				});
				try { child.kill('SIGTERM'); } catch { /* ignore */ }
			} else if (typeof pid === 'number') {
				try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
				clearTimeout(timer);
				done();
			} else {
				clearTimeout(timer);
				done();
			}
		});
	}

	readEndpoint(): ILucosDaemonEndpoint | undefined {
		return readDaemonEndpointFromDir(this.dataDir);
	}

	private async safeHealthy(endpoint: ILucosDaemonEndpoint): Promise<boolean> {
		try {
			return await this.options.isHealthy(endpoint);
		} catch {
			return false;
		}
	}

	private async spawnDaemon(binary: string): Promise<void> {
		const httpPort = await this.allocateHttpPort();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			LUCOS_GRPC_PORT: '0',
			LUCOS_HTTP_PORT: String(httpPort),
		};
		if (this.options.gatewayUrl) {
			env.LUCOS_GATEWAY_URL = this.options.gatewayUrl;
		}

		this.logService.info(`[lucosDaemon] Spawning ${binary} (http=${httpPort}, grpc=ephemeral)`);
		const child = this.spawnFn(binary, [], {
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
			detached: false,
		});

		this.ownedChild = child;
		this.ownedPid = child.pid;

		child.stdout?.on('data', (chunk: Buffer | string) => {
			this.logService.info(`[lucosDaemon:stdout] ${String(chunk).trimEnd()}`);
		});
		child.stderr?.on('data', (chunk: Buffer | string) => {
			this.logService.error(`[lucosDaemon:stderr] ${String(chunk).trimEnd()}`);
		});
		child.on('exit', (code, signal) => {
			this.logService.info(`[lucosDaemon] Owned process exited code=${code} signal=${signal}`);
			if (this.ownedChild === child) {
				this.ownedChild = undefined;
				this.ownedPid = undefined;
			}
		});
		child.on('error', err => {
			this.logService.error('[lucosDaemon] Failed to spawn daemon', err);
		});
	}

	private async waitForEndpoint(): Promise<ILucosDaemonEndpoint | undefined> {
		const deadline = Date.now() + this.pollTimeoutMs;
		while (Date.now() < deadline) {
			const endpoint = this.readEndpoint();
			if (endpoint) {
				const json = readDaemonJson(this.dataDir);
				if (json?.pid && this.ownedPid && json.pid === this.ownedPid) {
					return endpoint;
				}
				// Accept any fresh endpoint if pid is missing from our side
				if (endpoint && (!this.ownedPid || !json?.pid || isPidAlive(json.pid))) {
					return endpoint;
				}
			}
			await delay(this.pollIntervalMs);
		}
		return undefined;
	}
}

export function readDaemonEndpointFromDir(dataDir: string): ILucosDaemonEndpoint | undefined {
	const json = readDaemonJson(dataDir);
	if (!json) {
		return undefined;
	}
	const port = json.grpc_port ?? json.port;
	const token = json.local_session_token ?? json.session_token ?? json.token;
	if (!port || !token) {
		return undefined;
	}
	return { address: `127.0.0.1:${port}`, token };
}

export function readDaemonJson(dataDir: string): ILucosDaemonJson | undefined {
	try {
		const raw = readFileSync(join(dataDir, 'daemon.json'), 'utf8');
		return JSON.parse(raw) as ILucosDaemonJson;
	} catch {
		return undefined;
	}
}

export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function allocateEphemeralLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('Failed to allocate ephemeral port'));
				return;
			}
			const port = address.port;
			server.close(err => err ? reject(err) : resolve(port));
		});
	});
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
