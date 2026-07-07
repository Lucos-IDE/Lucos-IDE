/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — stub daemon service.
 *
 *  Lets the ENTIRE Lucos UI run before the real gRPC client (TW-161) and the daemon agent loop
 *  exist. It fakes a connected daemon, an in-memory auth status, and a plausible task stream
 *  (task.started → model.delta… → task.completed) so chat/timeline/status-bar can be built and
 *  demoed today. When TW-161 lands, swap the registration in lucos.contribution.ts to the real
 *  client — this file, and nothing in the UI, is the only thing that changes.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosAuthState, LucosConnectionState, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';

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

	private _setAuthStatus(status: ILucosAuthStatus): void {
		this._authStatus = status;
		this._onDidChangeAuthStatus.fire(status);
	}
}
