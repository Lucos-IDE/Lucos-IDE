/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexService } from '../common/lucosIndexService.js';
import { LucosConnectionState } from '../../../../platform/lucos/common/lucosProtocol.js';

export class LucosWorkspaceIndexWatcher extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosWorkspaceIndexWatcher';

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILucosDaemonService private readonly daemonService: ILucosDaemonService,
		@ILucosIndexService private readonly indexService: ILucosIndexService,
	) {
		super();

		// Trigger when the daemon first becomes connected (workspace may already be open).
		this._register(this.daemonService.onDidChangeConnectionState(state => {
			if (state === LucosConnectionState.Connected) {
				this.maybeIndex();
			}
		}));

		// Trigger when the workspace gains its first folder (user opens a folder while running).
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(e => {
			if (e.added.length > 0 && this.daemonService.connectionState === LucosConnectionState.Connected) {
				this.maybeIndex();
			}
		}));

		// Check immediately in case the daemon is already connected at contribution init time.
		this.maybeIndex();
	}

	private maybeIndex(): void {
		if (
			this.daemonService.connectionState !== LucosConnectionState.Connected ||
			this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY
		) {
			return;
		}
		// Fire and forget - LucosIndexService handles single-flight and error reporting.
		void this.indexService.index();
	}
}
