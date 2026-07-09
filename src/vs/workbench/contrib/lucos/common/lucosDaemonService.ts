/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — the single seam between the AI UI and the local Go daemon.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosConnectionState } from '../../../../platform/lucos/common/lucosProtocol.js';

export const ILucosDaemonService = createDecorator<ILucosDaemonService>('lucosDaemonService');

/**
 * The one place the Lucos UI talks to the local daemon.
 *
 * Every UI ticket — chat (TW-159), timeline (TW-162), status bar (TW-169), login (TW-198) —
 * depends ONLY on this interface, never on gRPC directly. Today it is backed by
 * {@link LucosDaemonServiceStub} so the entire UI is runnable and demoable without the daemon.
 * TW-161 replaces the registered implementation with a real gRPC-over-IPC client (node process,
 * reading `~/.lucos/daemon.json` for port + session token). Because the contract below is
 * transport-agnostic, no UI code changes when that swap happens.
 */
export interface ILucosDaemonService {
	readonly _serviceBrand: undefined;

	/** Current transport connection state to the local daemon. */
	readonly connectionState: LucosConnectionState;
	readonly onDidChangeConnectionState: Event<LucosConnectionState>;

	/** Latest known auth status; updated after auth RPCs and on daemon auth events (TW-193). */
	readonly authStatus: ILucosAuthStatus;
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus>;

	/** Daemon `Health` RPC — drives the status bar connection indicator (TW-169). */
	health(): Promise<ILucosHealth>;

	//#region Auth RPCs — map to daemon SetCloudCredentials/ClearCloudCredentials/GetAuthStatus (TW-190, done)
	getAuthStatus(): Promise<ILucosAuthStatus>;
	setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void>;
	clearCloudCredentials(): Promise<void>;
	//#endregion

	/**
	 * Start an autonomous agent task. Returns the server-streamed `TaskEvent`s as an async
	 * iterable; abort the underlying stream by cancelling `token`. Consumers switch on
	 * `event.kind` and are expected to ignore unknown kinds.
	 */
	startAgentTask(request: IStartAgentTaskRequest, token: CancellationToken): AsyncIterable<ITaskEvent>;

	//#region Patch flow (TW-165/166) — the daemon holds the pending patch and applies it on accept.
	/** Fetch a proposed patch by id (from a `patch.proposed` task event). */
	getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined>;
	/** Accept: the daemon applies the patch to the workspace (conflict-checked via base hashes). */
	applyPatch(patchId: string, workspaceRoot: string): Promise<ILucosApplyPatchResult>;
	/** Reject: discard the pending patch. */
	rejectPatch(patchId: string): Promise<void>;
	//#endregion

	/** List skills/agents the daemon discovered in the workspace (TW-184). */
	listCustomizations(workspaceRoot: string): Promise<ILucosCustomizations>;
}
