/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { ChildProcess } from 'child_process';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { ILucosDaemonEndpoint } from '../../node/lucosGrpcClient.js';
import { LucosDaemonProcessManager } from '../../node/lucosDaemonProcessManager.js';

class FakeChild extends EventEmitter {
	pid = 4242;
	killed = false;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill(_signal?: string): boolean {
		this.killed = true;
		queueMicrotask(() => this.emit('exit', 0, null));
		return true;
	}
}

suite('LucosDaemonProcessManager', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let dataDir: string;
	let spawnCalls: string[];

	setup(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'lucos-daemon-pm-'));
		spawnCalls = [];
	});

	teardown(() => {
		rmSync(dataDir, { recursive: true, force: true });
	});

	function writeDaemonJson(port: number, token: string, pid = 111): void {
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({
			pid,
			grpc_port: port,
			local_session_token: token,
		}));
	}

	test('adopts healthy existing daemon without spawning', async () => {
		writeDaemonJson(50051, 'token-a');
		const mgr = store.add(new LucosDaemonProcessManager(new NullLogService(), {
			dataDir,
			resolveBinary: () => '/tmp/fake-lucos-daemon',
			isHealthy: async () => true,
			spawnFn: ((bin: string) => {
				spawnCalls.push(bin);
				return new FakeChild() as unknown as ChildProcess;
			}) as typeof import('child_process').spawn,
		}));

		const endpoint = await mgr.ensureRunning();
		assert.deepStrictEqual(endpoint, { address: '127.0.0.1:50051', token: 'token-a' });
		assert.strictEqual(spawnCalls.length, 0);
		assert.strictEqual(mgr.ownsDaemon, false);
	});

	test('spawns when unhealthy and binary present', async () => {
		writeDaemonJson(50051, 'stale', 999999); // likely dead pid
		const mgr = store.add(new LucosDaemonProcessManager(new NullLogService(), {
			dataDir,
			resolveBinary: () => '/bundle/lucos-daemon',
			isHealthy: async () => false,
			pollIntervalMs: 20,
			pollTimeoutMs: 1000,
			allocateHttpPort: async () => 19599,
			spawnFn: ((bin: string) => {
				spawnCalls.push(bin);
				const child = new FakeChild();
				child.pid = 777;
				// Simulate daemon writing discovery file shortly after spawn.
				queueMicrotask(() => writeDaemonJson(50111, 'fresh-token', 777));
				return child as unknown as ChildProcess;
			}) as typeof import('child_process').spawn,
		}));

		const endpoint = await mgr.ensureRunning();
		assert.deepStrictEqual(spawnCalls, ['/bundle/lucos-daemon']);
		assert.deepStrictEqual(endpoint, { address: '127.0.0.1:50111', token: 'fresh-token' });
		assert.strictEqual(mgr.ownsDaemon, true);

		await mgr.stopOwnedDaemon();
		assert.strictEqual(mgr.ownsDaemon, false);
	});

	test('skips spawn when no binary and does not return unhealthy endpoint', async () => {
		writeDaemonJson(50051, 'token-b');
		const mgr = store.add(new LucosDaemonProcessManager(new NullLogService(), {
			dataDir,
			resolveBinary: () => undefined,
			isHealthy: async () => false,
			spawnFn: ((bin: string) => {
				spawnCalls.push(bin);
				return new FakeChild() as unknown as ChildProcess;
			}) as typeof import('child_process').spawn,
		}));

		const endpoint = await mgr.ensureRunning();
		assert.strictEqual(spawnCalls.length, 0);
		assert.strictEqual(endpoint, undefined);
	});

	test('times out when daemon.json never appears after spawn', async () => {
		const mgr = store.add(new LucosDaemonProcessManager(new NullLogService(), {
			dataDir,
			resolveBinary: () => '/bundle/lucos-daemon',
			isHealthy: async (_e: ILucosDaemonEndpoint) => false,
			pollIntervalMs: 10,
			pollTimeoutMs: 50,
			allocateHttpPort: async () => 19600,
			spawnFn: (() => new FakeChild() as unknown as ChildProcess) as typeof import('child_process').spawn,
		}));

		const endpoint = await mgr.ensureRunning();
		assert.strictEqual(endpoint, undefined);
	});

	test('notifies onOwnedDaemonExit when spawned child exits', async () => {
		let exitNotices = 0;
		let child: FakeChild | undefined;
		const mgr = store.add(new LucosDaemonProcessManager(new NullLogService(), {
			dataDir,
			resolveBinary: () => '/bundle/lucos-daemon',
			isHealthy: async () => false,
			pollIntervalMs: 20,
			pollTimeoutMs: 1000,
			allocateHttpPort: async () => 19601,
			onOwnedDaemonExit: () => { exitNotices++; },
			spawnFn: ((bin: string) => {
				spawnCalls.push(bin);
				child = new FakeChild();
				child.pid = 888;
				queueMicrotask(() => writeDaemonJson(50222, 'exit-token', 888));
				return child as unknown as ChildProcess;
			}) as typeof import('child_process').spawn,
		}));

		const endpoint = await mgr.ensureRunning();
		assert.ok(endpoint);
		assert.strictEqual(mgr.ownsDaemon, true);

		child!.kill('SIGTERM');
		await new Promise(resolve => setTimeout(resolve, 20));

		assert.strictEqual(exitNotices, 1);
		assert.strictEqual(mgr.ownsDaemon, false);
	});
});
