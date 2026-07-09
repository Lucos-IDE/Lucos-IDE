/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — status bar entry (TW-169).
 *  Shows daemon connection state + active model; clicking opens the chat. Reads only the seam
 *  (ILucosDaemonService) and settings, so it reflects the real client automatically once TW-161
 *  swaps the stub. Index-state (TW-203, cloud) is added here later behind the same entry.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { LucosConnectionState } from '../../../../platform/lucos/common/lucosProtocol.js';
import { LUCOS_FOCUS_CHAT_COMMAND_ID } from './lucosCommands.js';

export class LucosStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosStatusBar';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this.entry.value = this.statusbarService.addEntry(this.getEntry(), 'lucos.status', StatusbarAlignment.RIGHT, 100);

		this._register(this.lucosDaemonService.onDidChangeConnectionState(() => this.update()));
		this._register(this.lucosDaemonService.onDidChangeAuthStatus(() => this.update()));
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
		const model = this.configurationService.getValue<string>(LucosSettingId.AgentModel) ?? '';
		const icon = connected ? '$(sparkle)' : '$(debug-disconnect)';
		const label = connected
			? localize('lucos.status.connected', "Lucos")
			: localize('lucos.status.offline', "Lucos: offline");

		return {
			name: localize('lucos.status.name', "Lucos AI"),
			text: model ? `${icon} ${label} · ${model}` : `${icon} ${label}`,
			ariaLabel: localize('lucos.status.aria', "Lucos AI: {0}, model {1}", label, model),
			command: LUCOS_FOCUS_CHAT_COMMAND_ID,
			tooltip: localize('lucos.status.tooltip', "Lucos AI — click to open chat. Connection: {0}.", this.lucosDaemonService.connectionState),
		};
	}
}
