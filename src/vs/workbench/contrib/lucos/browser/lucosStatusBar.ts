/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexService } from '../common/lucosIndexService.js';
import { LucosConnectionState, LucosIndexState } from '../../../../platform/lucos/common/lucosProtocol.js';
import { LUCOS_FOCUS_CHAT_COMMAND_ID } from './lucosCommands.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';

export class LucosStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
		@ILucosIndexService private readonly lucosIndexService: ILucosIndexService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILucosAuthService private readonly lucosAuthService: ILucosAuthService,
	) {
		super();

		this.entry.value = this.statusbarService.addEntry(this.getEntry(), 'lucos.status', StatusbarAlignment.RIGHT, 100);

		this._register(this.lucosDaemonService.onDidChangeConnectionState(() => this.update()));
		this._register(this.lucosDaemonService.onDidChangeAuthStatus(() => this.update()));
		this._register(this.lucosIndexService.onDidChangeStatus(() => this.update()));
		this._register(this.lucosAuthService.onDidChangeSignInState(() => this.update()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LucosSettingId.AgentModel)) {
				this.update();
			}
		}));
	}

	private update(): void {
		this.entry.value?.update(this.getEntry());
	}

	private getEntry(): IStatusbarEntry {
		const connected = this.lucosDaemonService.connectionState === LucosConnectionState.Connected;
		const signedIn = this.lucosAuthService.isSignedIn;
		const user = this.lucosAuthService.signedInUser;
		const model = this.configurationService.getValue<string>(LucosSettingId.AgentModel) ?? '';
		const index = this.lucosIndexService.status;

		// Index state takes over the icon while working, and appends a short suffix otherwise (TW-169).
		let icon = connected ? '$(sparkle)' : (signedIn ? '$(account)' : '$(debug-disconnect)');
		let indexSuffix = '';
		switch (index.state) {
			case LucosIndexState.Indexing:
				icon = '$(sync~spin)';
				indexSuffix = localize('lucos.status.indexing', " · indexing…");
				break;
			case LucosIndexState.Indexed:
				indexSuffix = localize('lucos.status.indexed', " · indexed");
				break;
			case LucosIndexState.Stale:
				indexSuffix = localize('lucos.status.stale', " · index stale ({0})", index.staleCount ?? 0);
				break;
			case LucosIndexState.Failed:
				icon = connected ? '$(warning)' : icon;
				indexSuffix = localize('lucos.status.indexFailed', " · index failed");
				break;
		}

		// Label: show email when signed in and offline, so the user always knows their account.
		const userLabel = user?.email ?? user?.userId;
		const label = connected
			? localize('lucos.status.connected', "Lucos")
			: signedIn && userLabel
				? localize('lucos.status.signedInOffline', "Lucos: signed in ({0})", userLabel)
				: signedIn
					? localize('lucos.status.signedInOfflineNoUser', "Lucos: signed in")
					: localize('lucos.status.offline', "Lucos: offline");
		const modelSuffix = model ? ` · ${model}` : '';

		// Tooltip always shows the user identity when available.
		const userInfo = userLabel ? localize('lucos.status.tooltipUser', "User: {0}. ", userLabel) : '';
		const tooltipBase = userInfo + localize('lucos.status.tooltipConn', "Connection: {0}. Index: {1}.", this.lucosDaemonService.connectionState, index.state);

		return {
			name: localize('lucos.status.name', "Lucos AI"),
			text: `${icon} ${label}${indexSuffix}${modelSuffix}`,
			ariaLabel: localize('lucos.status.aria', "Lucos AI: {0}, index {1}, model {2}", label, index.state, model),
			command: LUCOS_FOCUS_CHAT_COMMAND_ID,
			tooltip: index.state === LucosIndexState.Failed && index.message
				? localize('lucos.status.tooltipFailed', "Lucos AI - indexing failed: {0}. Click to open chat.", index.message)
				: localize('lucos.status.tooltip', "Lucos AI - click to open chat. {0}", tooltipBase),
		};
	}
}
