/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — channel-facing daemon service (TW-161). Shared across the IPC boundary.
 *  Differs from the UI-facing ILucosDaemonService in ways a ProxyChannel requires:
 *    • no CancellationToken params (ProxyChannel cannot marshal them) — cancel is a separate call
 *    • the server-stream is start (returns a taskId) + a per-id dynamic event (`onDynamic…`)
 *    • state is exposed as async getters + static `onDidChange…` events (auto-buffered by fromService)
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosConnectionState } from './lucosProtocol.js';

export const ipcLucosDaemonChannelName = 'lucosDaemon';

export const ILucosDaemonNodeService = createDecorator<ILucosDaemonNodeService>('lucosDaemonNodeService');

export interface ILucosDaemonNodeService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeConnectionState: Event<LucosConnectionState>;
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus>;

	getConnectionState(): Promise<LucosConnectionState>;
	getAuthStatus(): Promise<ILucosAuthStatus>;

	health(): Promise<ILucosHealth>;
	setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void>;
	clearCloudCredentials(): Promise<void>;

	/** Begins a task; the stream is consumed via {@link onDynamicAgentTaskEvent}. */
	startAgentTask(request: IStartAgentTaskRequest): Promise<{ taskId: string }>;
	/** Aborts the underlying gRPC stream for a task (ProxyChannel-safe replacement for a token). */
	cancelAgentTask(taskId: string): Promise<void>;
	/** Per-task server-stream. `onDynamic` prefix is required by ProxyChannel for per-call events. */
	onDynamicAgentTaskEvent(taskId: string): Event<ITaskEvent>;

	//#region Patch flow (TW-165/166)
	getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined>;
	applyPatch(patchId: string, workspaceRoot: string): Promise<ILucosApplyPatchResult>;
	rejectPatch(patchId: string): Promise<void>;
	//#endregion

	/** Skills/agents discovered locally (TW-184). */
	listCustomizations(workspaceRoot: string): Promise<ILucosCustomizations>;
}
