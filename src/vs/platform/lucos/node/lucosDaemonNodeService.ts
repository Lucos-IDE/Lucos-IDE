/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { INativeEnvironmentService } from '../../environment/common/environment.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { ILucosDaemonNodeService } from '../common/lucosDaemonNode.js';
import { ILucosIndexWorkspaceRequest, ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosAuthState, LucosConnectionState, LucosTaskEventKind } from '../common/lucosProtocol.js';
import { LucosGrpcClient } from './lucosGrpcClient.js';
import { resolveLucosDaemonBinaryPath } from './lucosDaemonPath.js';
import { LucosDaemonProcessManager } from './lucosDaemonProcessManager.js';

type GrpcReadableStream<T> = import('@grpc/grpc-js').ClientReadableStream<T>;

const HEALTH_POLL_MS = 15_000;

interface ITaskEntry {
	readonly emitter: Emitter<ITaskEvent>;
	readonly start: () => GrpcReadableStream<Record<string, unknown>>;
	stream: GrpcReadableStream<Record<string, unknown>> | undefined;
}

export class LucosDaemonNodeService extends Disposable implements ILucosDaemonNodeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<LucosConnectionState>());
	readonly onDidChangeConnectionState: Event<LucosConnectionState> = this._onDidChangeConnectionState.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ILucosAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus> = this._onDidChangeAuthStatus.event;

	private readonly client = this._register(new LucosGrpcClient());
	private readonly tasks = new Map<string, ITaskEntry>();
	private readonly processManager: LucosDaemonProcessManager;

	private connectionState = LucosConnectionState.Disconnected;
	private authStatus: ILucosAuthStatus = { state: LucosAuthState.Unauthenticated, cloudReachable: false };
	private ensurePromise: Promise<void> | undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
		this.processManager = this._register(new LucosDaemonProcessManager(this.logService, {
			resolveBinary: () => resolveLucosDaemonBinaryPath({
				appRoot: this.environmentService.appRoot,
				isBuilt: this.environmentService.isBuilt,
			}),
			gatewayUrl: this.productService.lucosGatewayUrl,
			isHealthy: async endpoint => {
				try {
					await this.client.connect(endpoint);
					const health = await this.client.health();
					return !!health.serving;
				} catch {
					return false;
				}
			},
		}));

		this.ensurePromise = this.ensureThenConnect();
		const timer = setInterval(() => void this.refreshHealth(), HEALTH_POLL_MS);
		this._register(toDisposable(() => clearInterval(timer)));
		this._register(toDisposable(() => this.tasks.forEach(t => { t.stream?.cancel(); t.emitter.dispose(); })));
	}

	async shutdownOwnedDaemon(): Promise<void> {
		await this.processManager.stopOwnedDaemon();
		this.setConnectionState(LucosConnectionState.Disconnected);
	}

	async getConnectionState(): Promise<LucosConnectionState> {
		if (this.ensurePromise) {
			await this.ensurePromise;
		}
		return this.connectionState;
	}

	async getAuthStatus(): Promise<ILucosAuthStatus> {
		if (this.client.isConnected) {
			try {
				this.setAuthStatus(mapAuthStatus(await this.client.getAuthStatus()));
			} catch {
				// keep the cached status; the health poll will flip connection state if the daemon is gone
			}
		}
		return this.authStatus;
	}

	async health(): Promise<ILucosHealth> {
		const response = await this.client.health();
		return { serving: !!response.serving, version: response.version ?? '' };
	}

	async setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void> {
		const response = await this.client.setCloudCredentials({
			accessToken: credentials.accessToken,
			userId: credentials.userId ?? '',
			orgId: credentials.orgId ?? '',
			expiresAt: toTimestamp(credentials.expiresAt),
		});
		const status = (response.status as Record<string, unknown> | undefined);
		if (status) {
			this.setAuthStatus(mapAuthStatus(status));
		}
	}

	async clearCloudCredentials(): Promise<void> {
		const response = await this.client.clearCloudCredentials();
		const status = (response.status as Record<string, unknown> | undefined);
		this.setAuthStatus(status ? mapAuthStatus(status) : { state: LucosAuthState.Unauthenticated, cloudReachable: this.authStatus.cloudReachable });
	}

	async getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined> {
		try {
			return mapPatchProposal(await this.client.getPendingPatch({ patchId }));
		} catch {
			return undefined;
		}
	}

	async applyPatch(patchId: string, workspaceRoot: string): Promise<ILucosApplyPatchResult> {
		const response = await this.client.applyPatch({ patchId, workspaceRoot });
		return { patchId: (response.patchId as string) ?? patchId, filesChanged: asStringArray(response.filesChanged) };
	}

	async rejectPatch(patchId: string): Promise<void> {
		await this.client.rejectPatch({ patchId });
	}

	async listCustomizations(workspaceRoot: string): Promise<ILucosCustomizations> {
		try {
			return mapCustomizations(await this.client.listCustomizations({ workspaceRoot }));
		} catch {
			return { skills: [], agents: [] };
		}
	}

	async startAgentTask(request: IStartAgentTaskRequest): Promise<{ taskId: string }> {
		const grpcRequest: Record<string, unknown> = {
			goal: request.goal,
			sessionId: request.sessionId,
			model: request.model ?? '',
			permissionMode: request.permissionMode ?? '',
			workspaceId: request.context?.workspaceId ?? '',
			activeFile: request.context?.activeFile ?? '',
			selection: request.context?.selection ?? '',
			openBuffers: request.context?.openBuffers ?? [],
			workspaceRoot: request.context?.workspaceRoot ?? '',
			selectedAgentPath: request.selectedAgentPath ?? '',
			history: request.history ?? [],
		};
		return { taskId: this.beginTask(() => this.client.startAgentTask(grpcRequest)) };
	}

	async startIndexWorkspace(request: ILucosIndexWorkspaceRequest): Promise<{ taskId: string }> {
		const grpcRequest: Record<string, unknown> = {
			workspaceRoot: request.workspaceRoot,
			workspaceId: request.workspaceId ?? '',
			forceRescan: !!request.forceRescan,
			ignorePatterns: request.ignorePatterns ?? [],
		};
		return { taskId: this.beginTask(() => this.client.indexWorkspace(grpcRequest)) };
	}

	// Register a streaming task; start the gRPC stream lazily on first subscription so no events
	// are dropped between start…() and onDynamicAgentTaskEvent().
	private beginTask(start: () => GrpcReadableStream<Record<string, unknown>>): string {
		const taskId = generateUuid();
		const emitter = new Emitter<ITaskEvent>({ onWillAddFirstListener: () => this.beginStream(taskId) });
		this.tasks.set(taskId, { emitter, start, stream: undefined });
		return taskId;
	}

	async cancelAgentTask(taskId: string): Promise<void> {
		const entry = this.tasks.get(taskId);
		entry?.stream?.cancel();
		this.cleanupTask(taskId);
	}

	onDynamicAgentTaskEvent(taskId: string): Event<ITaskEvent> {
		return this.tasks.get(taskId)?.emitter.event ?? Event.None;
	}

	private beginStream(taskId: string): void {
		const entry = this.tasks.get(taskId);
		if (!entry) {
			return;
		}
		let stream: GrpcReadableStream<Record<string, unknown>>;
		try {
			stream = entry.start();
		} catch (error) {
			entry.emitter.fire(errorEvent(taskId, error));
			this.cleanupTask(taskId);
			return;
		}
		entry.stream = stream;
		stream.on('data', (event: Record<string, unknown>) => entry.emitter.fire(mapTaskEvent(taskId, event)));
		stream.on('end', () => {
			entry.emitter.fire({ taskId, kind: LucosTaskEventKind.TaskCompleted, sequence: -1, timestamp: Date.now(), severity: 'info', payload: {} });
			this.cleanupTask(taskId);
		});
		stream.on('error', (error: Error) => {
			entry.emitter.fire(errorEvent(taskId, error));
			this.cleanupTask(taskId);
		});
	}

	private cleanupTask(taskId: string): void {
		const entry = this.tasks.get(taskId);
		if (entry) {
			this.tasks.delete(taskId);
			// Defer disposal so in-flight listeners receive the final event first.
			queueMicrotask(() => entry.emitter.dispose());
		}
	}

	private async ensureThenConnect(): Promise<void> {
		this.setConnectionState(LucosConnectionState.Connecting);
		try {
			const endpoint = await this.processManager.ensureRunning();
			if (!endpoint) {
				this.setConnectionState(LucosConnectionState.Disconnected);
				return;
			}
			await this.client.connect(endpoint);
			// Probe health directly — do not call refreshHealth() here (it awaits
			// ensurePromise and would deadlock on the in-flight ensureThenConnect).
			const response = await this.client.health();
			this.setConnectionState(response.serving ? LucosConnectionState.Connected : LucosConnectionState.Disconnected);
			this.logService.info(`[lucosDaemon] Connected to ${endpoint.address} (serving=${!!response.serving})`);
		} catch (error) {
			this.logService.error('[lucosDaemon] Failed to ensure/connect daemon', error);
			this.setConnectionState(LucosConnectionState.Disconnected);
		}
	}

	private tryConnect(): void {
		const endpoint = this.processManager.readEndpoint();
		if (!endpoint) {
			this.setConnectionState(LucosConnectionState.Disconnected);
			return;
		}
		void this.client.connect(endpoint).then(async () => {
			try {
				const response = await this.client.health();
				this.setConnectionState(response.serving ? LucosConnectionState.Connected : LucosConnectionState.Disconnected);
			} catch {
				this.setConnectionState(LucosConnectionState.Disconnected);
			}
		}).catch(() => {
			this.setConnectionState(LucosConnectionState.Disconnected);
		});
	}

	private async refreshHealth(): Promise<void> {
		// Wait for the in-flight startup ensure to finish without re-entering it.
		const pendingEnsure = this.ensurePromise;
		if (pendingEnsure) {
			await pendingEnsure;
			if (this.ensurePromise === pendingEnsure) {
				this.ensurePromise = undefined;
			}
		}

		if (!this.client.isConnected) {
			// When disconnected, prefer a full ensure (may spawn) over raw reconnect.
			if (!this.processManager.ownsDaemon) {
				this.ensurePromise = this.ensureThenConnect();
				await this.ensurePromise;
				this.ensurePromise = undefined;
				return;
			}
			this.tryConnect();
			return;
		}
		try {
			const response = await this.client.health();
			this.setConnectionState(response.serving ? LucosConnectionState.Connected : LucosConnectionState.Disconnected);
		} catch {
			this.setConnectionState(LucosConnectionState.Disconnected);
			// The daemon may have restarted with a rotated token — reconnect from daemon.json.
			this.tryConnect();
		}
	}

	private setConnectionState(state: LucosConnectionState): void {
		if (this.connectionState !== state) {
			this.connectionState = state;
			if (state === LucosConnectionState.Disconnected) {
				// Daemon cloud JWT is memory-only; treat disconnect as unauthenticated until re-handoff.
				this.setAuthStatus({ state: LucosAuthState.Unauthenticated, cloudReachable: false });
			}
			this._onDidChangeConnectionState.fire(state);
		}
	}

	private setAuthStatus(status: ILucosAuthStatus): void {
		this.authStatus = status;
		this._onDidChangeAuthStatus.fire(status);
	}
}

function errorEvent(taskId: string, error: unknown): ITaskEvent {
	const message = error instanceof Error ? error.message : String(error);
	return { taskId, kind: LucosTaskEventKind.Error, sequence: -1, timestamp: Date.now(), severity: 'error', payload: { message } };
}

function mapTaskEvent(taskId: string, event: Record<string, unknown>): ITaskEvent {
	let payload: unknown = {};
	const payloadJson = event.payloadJson;
	if (typeof payloadJson === 'string' && payloadJson.length) {
		try { payload = JSON.parse(payloadJson); } catch { payload = { raw: payloadJson }; }
	}
	return {
		taskId: (event.taskId as string) ?? taskId,
		kind: (event.eventType as string) ?? LucosTaskEventKind.Error,
		sequence: Number(event.sequence ?? 0),
		timestamp: timestampToMs(event.timestamp) ?? Date.now(),
		severity: (event.severity as string) ?? 'info',
		payload,
	};
}

function mapAuthStatus(status: Record<string, unknown>): ILucosAuthStatus {
	return {
		state: mapAuthState(status.state as string | undefined),
		userId: (status.userId as string) || undefined,
		orgId: (status.orgId as string) || undefined,
		planCode: (status.planCode as string) || undefined,
		roles: Array.isArray(status.roles) ? status.roles as string[] : undefined,
		cloudReachable: !!status.cloudReachable,
		tokenExpiresAt: timestampToMs(status.tokenExpiresAt),
	};
}

function mapAuthState(state: string | undefined): LucosAuthState {
	switch (state) {
		case 'AUTH_STATE_UNAUTHENTICATED': return LucosAuthState.Unauthenticated;
		case 'AUTH_STATE_AUTHENTICATING': return LucosAuthState.Authenticating;
		case 'AUTH_STATE_AUTHENTICATED': return LucosAuthState.Authenticated;
		case 'AUTH_STATE_TOKEN_EXPIRED': return LucosAuthState.TokenExpired;
		case 'AUTH_STATE_CLOUD_UNREACHABLE': return LucosAuthState.CloudUnreachable;
		case 'AUTH_STATE_OFFLINE_MODE': return LucosAuthState.OfflineMode;
		default: return LucosAuthState.Unspecified;
	}
}

function timestampToMs(timestamp: unknown): number | undefined {
	if (!timestamp || typeof timestamp !== 'object') {
		return undefined;
	}
	const ts = timestamp as { seconds?: string | number; nanos?: number };
	if (ts.seconds === undefined) {
		return undefined;
	}
	return Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1_000_000);
}

function toTimestamp(ms: number | undefined): { seconds: string; nanos: number } | undefined {
	if (!ms) {
		return undefined;
	}
	return { seconds: String(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1_000_000 };
}

function mapPatchProposal(proposal: Record<string, unknown>): ILucosPatchProposal | undefined {
	if (!proposal || typeof proposal.patchId !== 'string') {
		return undefined;
	}
	const changes = Array.isArray(proposal.fileChanges) ? proposal.fileChanges as Record<string, unknown>[] : [];
	return {
		patchId: proposal.patchId,
		taskId: (proposal.taskId as string) || undefined,
		summary: (proposal.summary as string) ?? '',
		fileChanges: changes.map(change => ({
			path: (change.path as string) ?? '',
			oldText: (change.oldText as string) ?? '',
			newText: (change.newText as string) ?? '',
			baseHash: (change.baseHash as string) || undefined,
		})),
		status: (proposal.status as string) || undefined,
	};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function mapCustomizations(snapshot: Record<string, unknown>): ILucosCustomizations {
	const skills = Array.isArray(snapshot?.skills) ? snapshot.skills as Record<string, unknown>[] : [];
	const agents = Array.isArray(snapshot?.agents) ? snapshot.agents as Record<string, unknown>[] : [];
	return {
		skills: skills.map(skill => ({
			name: (skill.name as string) ?? '',
			description: (skill.description as string) ?? '',
			path: (skill.path as string) ?? '',
			scope: (skill.scope as string) ?? '',
			userInvocable: !!skill.userInvocable,
		})),
		agents: agents.map(agent => ({
			name: (agent.name as string) ?? '',
			displayName: (agent.displayName as string) || (agent.name as string) || '',
			description: (agent.description as string) ?? '',
			path: (agent.path as string) ?? '',
			scope: (agent.scope as string) ?? '',
			model: (agent.model as string) || undefined,
		})),
	};
}
