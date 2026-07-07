/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — renderer-side daemon service (TW-161).
 *  Implements the UI-facing ILucosDaemonService by proxying the main-process ILucosDaemonNodeService
 *  over IPC. The channel exposes start + per-task event; here we recombine them into the
 *  AsyncIterable the UI expects, and cache connection/auth state for the synchronous getters.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILucosDaemonNodeService } from '../../../../platform/lucos/common/lucosDaemonNode.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosAuthState, LucosConnectionState, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';

export class LucosDaemonServiceRemote extends Disposable implements ILucosDaemonService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<LucosConnectionState>());
	readonly onDidChangeConnectionState: Event<LucosConnectionState> = this._onDidChangeConnectionState.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ILucosAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus> = this._onDidChangeAuthStatus.event;

	private _connectionState = LucosConnectionState.Connecting;
	get connectionState(): LucosConnectionState { return this._connectionState; }

	private _authStatus: ILucosAuthStatus = { state: LucosAuthState.Unauthenticated, cloudReachable: false };
	get authStatus(): ILucosAuthStatus { return this._authStatus; }

	constructor(
		@ILucosDaemonNodeService private readonly nodeService: ILucosDaemonNodeService,
	) {
		super();

		this._register(this.nodeService.onDidChangeConnectionState(state => {
			this._connectionState = state;
			this._onDidChangeConnectionState.fire(state);
		}));
		this._register(this.nodeService.onDidChangeAuthStatus(status => {
			this._authStatus = status;
			this._onDidChangeAuthStatus.fire(status);
		}));

		void this.syncInitialState();
	}

	health(): Promise<ILucosHealth> {
		return this.nodeService.health();
	}

	getAuthStatus(): Promise<ILucosAuthStatus> {
		return this.nodeService.getAuthStatus();
	}

	setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void> {
		return this.nodeService.setCloudCredentials(credentials);
	}

	clearCloudCredentials(): Promise<void> {
		return this.nodeService.clearCloudCredentials();
	}

	getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined> {
		return this.nodeService.getPendingPatch(patchId);
	}

	applyPatch(patchId: string, workspaceRoot: string): Promise<ILucosApplyPatchResult> {
		return this.nodeService.applyPatch(patchId, workspaceRoot);
	}

	rejectPatch(patchId: string): Promise<void> {
		return this.nodeService.rejectPatch(patchId);
	}

	listCustomizations(workspaceRoot: string): Promise<ILucosCustomizations> {
		return this.nodeService.listCustomizations(workspaceRoot);
	}

	startAgentTask(request: IStartAgentTaskRequest, token: CancellationToken): AsyncIterable<ITaskEvent> {
		let taskId: string | undefined;
		const subscriptions = new DisposableStore();
		const source = new AsyncIterableSource<ITaskEvent>(() => {
			// Consumer stopped iterating early — cancel the daemon task and stop forwarding.
			if (taskId) {
				void this.nodeService.cancelAgentTask(taskId);
			}
			subscriptions.dispose();
		});

		(async () => {
			try {
				const started = await this.nodeService.startAgentTask(request);
				taskId = started.taskId;
				if (token.isCancellationRequested) {
					void this.nodeService.cancelAgentTask(taskId);
					source.resolve();
					return;
				}
				subscriptions.add(token.onCancellationRequested(() => {
					if (taskId) {
						void this.nodeService.cancelAgentTask(taskId);
					}
					source.resolve();
					subscriptions.dispose();
				}));
				subscriptions.add(this.nodeService.onDynamicAgentTaskEvent(taskId)(event => {
					if (event.kind === LucosTaskEventKind.TaskCompleted) {
						source.resolve();
						subscriptions.dispose();
					} else if (event.kind === LucosTaskEventKind.Error) {
						source.emitOne(event);
						source.resolve();
						subscriptions.dispose();
					} else {
						source.emitOne(event);
					}
				}));
			} catch (error) {
				source.reject(error instanceof Error ? error : new Error(String(error)));
			}
		})();

		return source.asyncIterable;
	}

	private async syncInitialState(): Promise<void> {
		try {
			this._connectionState = await this.nodeService.getConnectionState();
			this._onDidChangeConnectionState.fire(this._connectionState);
		} catch {
			// leave as Connecting; the change event will correct it
		}
		try {
			this._authStatus = await this.nodeService.getAuthStatus();
			this._onDidChangeAuthStatus.fire(this._authStatus);
		} catch {
			// keep default unauthenticated status
		}
	}
}
