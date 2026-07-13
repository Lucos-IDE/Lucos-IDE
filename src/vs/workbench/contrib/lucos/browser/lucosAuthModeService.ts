/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lucos IDE - ILucosAuthModeService implementation (TW-178 / TW-197).

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosAuthModeService } from '../common/lucosAuthModeService.js';

export class LucosAuthModeService extends Disposable implements ILucosAuthModeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeMode = this._register(new Emitter<boolean>());
	readonly onDidChangeMode: Event<boolean> = this._onDidChangeMode.event;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LucosSettingId.AuthMode)) {
				this._onDidChangeMode.fire(this.isLocalOnly);
			}
		}));
	}

	get isLocalOnly(): boolean {
		return this.configurationService.getValue<string>(LucosSettingId.AuthMode) === 'local-only';
	}

	requireCloud(notificationService: INotificationService): boolean {
		if (!this.isLocalOnly) {
			return true;
		}
		notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'lucos.authMode.cloudRequired',
				"This feature requires cloud mode. Set `lucos.auth.mode` to `cloud` and sign in to use Lucos AI.",
			),
		});
		return false;
	}
}
