/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexWorkspaceRequest, ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosAuthState, LucosConnectionState, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';

export class LucosDaemonServiceStub extends Disposable implements ILucosDaemonService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeConnectionState = this._register(new Emitter<LucosConnectionState>());
	readonly onDidChangeConnectionState: Event<LucosConnectionState> = this._onDidChangeConnectionState.event;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<ILucosAuthStatus>());
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus> = this._onDidChangeAuthStatus.event;

	private _connectionState = LucosConnectionState.Connected;
	get connectionState(): LucosConnectionState { return this._connectionState; }

	private _authStatus: ILucosAuthStatus = { state: LucosAuthState.Unauthenticated, cloudReachable: true };
	get authStatus(): ILucosAuthStatus { return this._authStatus; }

	async health(): Promise<ILucosHealth> {
		return { serving: true, version: 'stub' };
	}

	async getAuthStatus(): Promise<ILucosAuthStatus> {
		return this._authStatus;
	}

	async setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void> {
		this._setAuthStatus({
			state: LucosAuthState.Authenticated,
			userId: credentials.userId,
			orgId: credentials.orgId,
			cloudReachable: true,
			tokenExpiresAt: credentials.expiresAt,
		});
	}

	async clearCloudCredentials(): Promise<void> {
		this._setAuthStatus({ state: LucosAuthState.Unauthenticated, cloudReachable: true });
	}

	async respondToPermission(_taskId: string, _toolCallId: string, _approved: boolean, _denyReason?: string): Promise<void> {
		// no-op in the stub
	}

	async getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined> {
		return { patchId, summary: 'Stub patch (no real changes).', fileChanges: [] };
	}

	async applyPatch(patchId: string): Promise<ILucosApplyPatchResult> {
		return { patchId, filesChanged: [] };
	}

	async rejectPatch(): Promise<void> {
		// no-op in the stub
	}

	async listCustomizations(): Promise<ILucosCustomizations> {
		return { skills: [], agents: [] };
	}

	async *startAgentTask(request: IStartAgentTaskRequest, token: CancellationToken): AsyncIterable<ITaskEvent> {
		const taskId = `stub-${request.sessionId}`;
		let sequence = 0;
		const emit = (kind: LucosTaskEventKind, payload: unknown): ITaskEvent =>
			({ taskId, kind, sequence: ++sequence, timestamp: Date.now(), severity: 'info', payload });

		yield emit(LucosTaskEventKind.TaskStarted, { goal: request.goal });

		const reply = `Stub response to: "${request.goal}". Real answers arrive with the daemon agent loop (TW-161 + Girish's daemon).`;
		for (const word of reply.split(' ')) {
			if (token.isCancellationRequested) {
				return;
			}
			await timeout(25);
			yield emit(LucosTaskEventKind.ModelDelta, { textDelta: word + ' ' });
		}

		yield emit(LucosTaskEventKind.TaskCompleted, { summary: 'Stub task complete.' });
	}

	async *indexWorkspace(request: ILucosIndexWorkspaceRequest, token: CancellationToken): AsyncIterable<ITaskEvent> {
		let sequence = 0;
		const emit = (kind: LucosTaskEventKind, payload: unknown): ITaskEvent =>
			({ taskId: 'stub-index', kind, sequence: ++sequence, timestamp: Date.now(), severity: 'info', payload });

		yield emit(LucosTaskEventKind.IndexStarted, { workspace_root: request.workspaceRoot });
		for (let i = 1; i <= 3; i++) {
			if (token.isCancellationRequested) {
				return;
			}
			await timeout(150);
			yield emit(LucosTaskEventKind.IndexProgress, { files_indexed: i * 4, chunks_total: i * 20 });
		}
		yield emit(LucosTaskEventKind.IndexCompleted, { files_indexed: 12, chunks_total: 60, stale_count: 0, status: 'local_index_ready' });
	}

	private _setAuthStatus(status: ILucosAuthStatus): void {
		this._authStatus = status;
		this._onDidChangeAuthStatus.fire(status);
	}
}
