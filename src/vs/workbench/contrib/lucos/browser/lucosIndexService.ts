/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lucos IDE - workspace indexing (TW-220 / TW-169 / TW-170 / TW-172).
// Drives the daemon's IndexWorkspace stream, folds the `index.*` TaskEvents into a single
// ILucosIndexStatus (idle -> indexing -> indexed/stale/failed), and surfaces completion/failure
// as notifications. The status bar reads `status`/`onDidChangeStatus`; the command calls `index()`.

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ILucosIndexStatus, ILucosIndexWorkspaceRequest, ITaskEvent, LucosConnectionState, LucosIndexState, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexService } from '../common/lucosIndexService.js';

export class LucosIndexService extends Disposable implements ILucosIndexService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<ILucosIndexStatus>());
	readonly onDidChangeStatus: Event<ILucosIndexStatus> = this._onDidChangeStatus.event;

	private _status: ILucosIndexStatus = { state: LucosIndexState.Idle };
	get status(): ILucosIndexStatus { return this._status; }

	/** Non-undefined while an index run is in flight - also our single-flight guard. */
	private activeRun: CancellationTokenSource | undefined;

	constructor(
		@ILucosDaemonService private readonly daemonService: ILucosDaemonService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._register({ dispose: () => this.activeRun?.dispose() });
	}

	async index(force = false): Promise<void> {
		if (this.activeRun) {
			return; // already indexing - ignore re-entrancy
		}
		if (this.daemonService.connectionState !== LucosConnectionState.Connected) {
			this.notificationService.warn(localize('lucos.index.offline', "Lucos daemon is offline - connect before indexing the workspace."));
			return;
		}
		const workspace = this.workspaceContextService.getWorkspace();
		const folder = workspace.folders[0];
		if (!folder) {
			this.notificationService.info(localize('lucos.index.noWorkspace', "Open a folder to index it with Lucos."));
			return;
		}

		const request: ILucosIndexWorkspaceRequest = {
			workspaceRoot: folder.uri.fsPath,
			workspaceId: workspace.id,
			forceRescan: force,
			ignorePatterns: this.configurationService.getValue<string[]>(LucosSettingId.ContextIgnorePatterns) ?? [],
		};
		const cts = new CancellationTokenSource();
		this.activeRun = cts;
		this.setStatus({ state: LucosIndexState.Indexing });

		try {
			for await (const event of this.daemonService.indexWorkspace(request, cts.token)) {
				this.handleEvent(event);
			}
			// Stream ended without an explicit completed/failed event - assume success.
			if (this._status.state === LucosIndexState.Indexing) {
				this.setStatus({ state: LucosIndexState.Indexed, filesIndexed: this._status.filesIndexed, chunksTotal: this._status.chunksTotal });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setStatus({ state: LucosIndexState.Failed, message });
			this.notificationService.error(localize('lucos.index.error', "Lucos indexing failed: {0}", message));
		} finally {
			cts.dispose();
			this.activeRun = undefined;
		}
	}

	private handleEvent(event: ITaskEvent): void {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		switch (event.kind) {
			case LucosTaskEventKind.IndexStarted:
				this.setStatus({ state: LucosIndexState.Indexing });
				break;
			case LucosTaskEventKind.IndexProgress:
			case LucosTaskEventKind.IndexUploadStarted:
			case LucosTaskEventKind.IndexUploadProgress:
			case LucosTaskEventKind.IndexCloudStatus:
				this.setStatus({
					state: LucosIndexState.Indexing,
					filesIndexed: num(payload.files_indexed ?? payload.filesIndexed) ?? this._status.filesIndexed,
					chunksTotal: num(payload.chunks_total ?? payload.chunksTotal) ?? this._status.chunksTotal,
					staleCount: num(payload.stale_count ?? payload.staleCount) ?? this._status.staleCount,
				});
				break;
			case LucosTaskEventKind.IndexCompleted: {
				// The completed payload carries `cloud_state` (e.g. 'stale'); the file-level
				// `stale_count` arrives on the preceding cloud.status event, so read it from state.
				const cloudState = str(payload.cloud_state ?? payload.cloudState);
				const staleCount = num(payload.stale_count ?? payload.staleCount) ?? this._status.staleCount ?? 0;
				const isStale = cloudState === 'stale' || staleCount > 0;
				const filesIndexed = num(payload.files_indexed ?? payload.filesIndexed) ?? this._status.filesIndexed;
				this.setStatus({
					state: isStale ? LucosIndexState.Stale : LucosIndexState.Indexed,
					filesIndexed,
					chunksTotal: num(payload.chunks_total ?? payload.chunksTotal) ?? this._status.chunksTotal,
					staleCount,
				});
				this.notificationService.info(isStale
					? localize('lucos.index.doneStale', "Lucos: workspace indexed with {0} stale file(s).", staleCount)
					: localize('lucos.index.done', "Lucos: workspace indexed ({0} files).", filesIndexed ?? 0));
				break;
			}
			case LucosTaskEventKind.IndexFailed: {
				const message = str(payload.message) || str(payload.code) || localize('lucos.index.unknown', "unknown error");
				this.setStatus({ state: LucosIndexState.Failed, message });
				this.notificationService.error(localize('lucos.index.error', "Lucos indexing failed: {0}", message));
				break;
			}
		}
	}

	private setStatus(status: ILucosIndexStatus): void {
		this._status = status;
		this._onDidChangeStatus.fire(status);
	}
}

function num(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
		return Number(value);
	}
	return undefined;
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : '';
}
