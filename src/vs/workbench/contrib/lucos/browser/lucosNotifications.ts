/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — global notifications (TW-170).
 *  Surfaces a debounced "agent offline" warning globally (the in-panel banner from TW-172 only
 *  shows when the chat view is open). Index/update/test notifications layer on here once the
 *  cloud index-status (TW-203) and release-server (TW-210) APIs exist.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { LucosConnectionState } from '../../../../platform/lucos/common/lucosProtocol.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

const OFFLINE_DEBOUNCE_MS = 60_000;

export class LucosNotificationsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosNotifications';

	private lastOfflineNotified = 0;

	constructor(
		@ILucosDaemonService lucosDaemonService: ILucosDaemonService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();
		this._register(lucosDaemonService.onDidChangeConnectionState(state => this.onConnectionState(state)));
	}

	private onConnectionState(state: LucosConnectionState): void {
		if (state !== LucosConnectionState.Disconnected) {
			return;
		}
		const now = Date.now();
		if (now - this.lastOfflineNotified < OFFLINE_DEBOUNCE_MS) {
			return;
		}
		this.lastOfflineNotified = now;
		this.notificationService.notify({
			severity: Severity.Warning,
			message: localize('lucos.notify.offline', "Lucos agent is offline — AI features are unavailable until it reconnects."),
		});
	}
}
