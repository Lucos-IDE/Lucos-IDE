/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — node/main-process daemon service (TW-161). Implements the channel-facing
 *  ILucosDaemonNodeService by driving the raw gRPC client and translating wire types into the
 *  IDE's domain types. Runs in the main process; the renderer reaches it over a ProxyChannel.
 *--------------------------------------------------------------------------------------------*/

import type * as grpc from '@grpc/grpc-js';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { join } from '../../../base/common/path.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { ILucosDaemonNodeService } from '../common/lucosDaemonNode.js';
import { ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosAuthState, LucosConnectionState, LucosTaskEventKind } from '../common/lucosProtocol.js';
import { ILucosDaemonEndpoint, LucosGrpcClient } from './lucosGrpcClient.js';

const HEALTH_POLL_MS = 15_000;

interface ITaskEntry {
	readonly emitter: Emitter<ITaskEvent>;
	stream: grpc.ClientReadableStream<Record<string, unknown>> | undefined;
}

export class LucosDaemonNodeService extends Disposable implements ILucosDaemonNodeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<LucosConnectionState>());
	readonly onDidChangeConnectionState: Event<LucosConnectionState> = this._onDidChangeConnectionState.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ILucosAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus> = this._onDidChangeAuthStatus.event;

	private readonly client = this._register(new LucosGrpcClient());
	private readonly tasks = new Map<string, ITaskEntry>();

	private connectionState = LucosConnectionState.Disconnected;
	private authStatus: ILucosAuthStatus = { state: LucosAuthState.Unauthenticated, cloudReachable: false };

	constructor() {
		super();
		this.tryConnect();
		const timer = setInterval(() => void this.refreshHealth(), HEALTH_POLL_MS);
		this._register(toDisposable(() => clearInterval(timer)));
		this._register(toDisposable(() => this.tasks.forEach(t => { t.stream?.cancel(); t.emitter.dispose(); })));
	}

	async getConnectionState(): Promise<LucosConnectionState> {
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
		const taskId = generateUuid();
		const grpcRequest: Record<string, unknown> = {
			goal: request.goal,
			sessionId: request.sessionId,
			model: request.model ?? '',
			permissionMode: request.permissionMode ?? '',
			workspaceId: request.context?.workspaceId ?? '',
			activeFile: request.context?.activeFile ?? '',
			selection: request.context?.selection ?? '',
			openBuffers: request.context?.openBuffers ?? [],
			workspaceRoot: '',
			selectedAgentPath: request.selectedAgentPath ?? '',
		};
		// Start the gRPC stream lazily, only once the renderer subscribes to the per-task event,
		// so no events are dropped in the gap between startAgentTask() and onDynamicAgentTaskEvent().
		const emitter = new Emitter<ITaskEvent>({ onWillAddFirstListener: () => this.beginStream(taskId, grpcRequest) });
		this.tasks.set(taskId, { emitter, stream: undefined });
		return { taskId };
	}

	async cancelAgentTask(taskId: string): Promise<void> {
		const entry = this.tasks.get(taskId);
		entry?.stream?.cancel();
		this.cleanupTask(taskId);
	}

	onDynamicAgentTaskEvent(taskId: string): Event<ITaskEvent> {
		return this.tasks.get(taskId)?.emitter.event ?? Event.None;
	}

	private beginStream(taskId: string, grpcRequest: Record<string, unknown>): void {
		const entry = this.tasks.get(taskId);
		if (!entry) {
			return;
		}
		let stream: grpc.ClientReadableStream<Record<string, unknown>>;
		try {
			stream = this.client.startAgentTask(grpcRequest);
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

	private tryConnect(): void {
		const endpoint = readDaemonEndpoint();
		if (!endpoint) {
			this.setConnectionState(LucosConnectionState.Disconnected);
			return;
		}
		try {
			this.client.connect(endpoint);
			void this.refreshHealth();
		} catch {
			this.setConnectionState(LucosConnectionState.Disconnected);
		}
	}

	private async refreshHealth(): Promise<void> {
		if (!this.client.isConnected) {
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
			this._onDidChangeConnectionState.fire(state);
		}
	}

	private setAuthStatus(status: ILucosAuthStatus): void {
		this.authStatus = status;
		this._onDidChangeAuthStatus.fire(status);
	}
}

function readDaemonEndpoint(): ILucosDaemonEndpoint | undefined {
	try {
		const raw = readFileSync(join(homedir(), '.lucos', 'daemon.json'), 'utf8');
		const json = JSON.parse(raw) as { port?: number; grpc_port?: number; token?: string; session_token?: string };
		const port = json.grpc_port ?? json.port;
		const token = json.session_token ?? json.token;
		if (!port || !token) {
			return undefined;
		}
		return { address: `127.0.0.1:${port}`, token };
	} catch {
		return undefined;
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
