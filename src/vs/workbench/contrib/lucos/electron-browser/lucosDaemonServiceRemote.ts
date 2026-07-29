/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILucosDaemonNodeService } from '../../../../platform/lucos/common/lucosDaemonNode.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexWorkspaceRequest, ILucosApplyPatchResult, ILucosRevertPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosAuthState, LucosConnectionState, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';

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

	async reconnect(): Promise<LucosConnectionState> {
		const state = await this.nodeService.reconnect();
		this._connectionState = state;
		this._onDidChangeConnectionState.fire(state);
		return state;
	}

	getAuthStatus(): Promise<ILucosAuthStatus> {
		return this.nodeService.getAuthStatus().then(status => {
			this._authStatus = status;
			return status;
		});
	}

	setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void> {
		return this.nodeService.setCloudCredentials(credentials);
	}

	clearCloudCredentials(): Promise<void> {
		return this.nodeService.clearCloudCredentials();
	}

	respondToPermission(taskId: string, toolCallId: string, approved: boolean, denyReason?: string): Promise<void> {
		return this.nodeService.respondToPermission(taskId, toolCallId, approved, denyReason);
	}

	getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined> {
		return this.nodeService.getPendingPatch(patchId);
	}

	applyPatch(patchId: string, workspaceRoot: string, paths?: readonly string[]): Promise<ILucosApplyPatchResult> {
		return this.nodeService.applyPatch(patchId, workspaceRoot, paths);
	}

	rejectPatch(patchId: string): Promise<void> {
		return this.nodeService.rejectPatch(patchId);
	}

	revertPatchFiles(patchId: string, workspaceRoot: string, paths?: readonly string[]): Promise<ILucosRevertPatchResult> {
		return this.nodeService.revertPatchFiles(patchId, workspaceRoot, paths);
	}

	listCustomizations(workspaceRoot: string): Promise<ILucosCustomizations> {
		return this.nodeService.listCustomizations(workspaceRoot);
	}

	startAgentTask(request: IStartAgentTaskRequest, token: CancellationToken): AsyncIterable<ITaskEvent> {
		return this.consumeStream(() => this.nodeService.startAgentTask(request), token);
	}

	indexWorkspace(request: ILucosIndexWorkspaceRequest, token: CancellationToken): AsyncIterable<ITaskEvent> {
		return this.consumeStream(() => this.nodeService.startIndexWorkspace(request), token);
	}

	// Shared wrapper: begin a server-stream (agent task or index), recombine the per-task channel
	// events into the AsyncIterable the UI expects, and cancel the daemon stream on early return.
	private consumeStream(begin: () => Promise<{ taskId: string }>, token: CancellationToken): AsyncIterable<ITaskEvent> {
		let taskId: string | undefined;
		const subscriptions = new DisposableStore();
		const source = new AsyncIterableSource<ITaskEvent>(() => {
			if (taskId) {
				void this.nodeService.cancelAgentTask(taskId);
			}
			subscriptions.dispose();
		});

		(async () => {
			try {
				const started = await begin();
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
						source.emitOne(event);
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
