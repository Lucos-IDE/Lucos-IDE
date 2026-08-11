/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { LucosAuthState } from '../../../../platform/lucos/common/lucosProtocol.js';

/**
 * Dynamically updates the Lucos account info setting description to show signed-in user details.
 */
export class LucosAccountSettingsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.lucosAccountSettings';

	constructor(
		@ILucosAuthService private readonly lucosAuthService: ILucosAuthService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();

		this._register(this.lucosAuthService.onDidChangeSignInState(() => this.updateAccountInfo()));
		this._register(this.lucosDaemonService.onDidChangeAuthStatus(() => this.updateAccountInfo()));

		void this.lucosAuthService.restorePromise.then(() => this.updateAccountInfo());
	}

	private updateAccountInfo(): void {
		const configRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const user = this.lucosAuthService.signedInUser;
		const authStatus = this.lucosDaemonService.authStatus;
		const isSignedIn = this.lucosAuthService.isSignedIn;

		let description: string;

		if (isSignedIn && user) {
			const details: string[] = [];

			details.push(`**Email:** ${user.email || '—'}`);

			if (user.userId) {
				details.push(`**User ID:** ${user.userId}`);
			}

			if (authStatus.state === LucosAuthState.Authenticated) {
				if (authStatus.orgId) {
					details.push(`**Organization:** ${authStatus.orgId}`);
				}
				if (authStatus.planCode) {
					details.push(`**Plan:** ${authStatus.planCode}`);
				}
				if (authStatus.roles && authStatus.roles.length > 0) {
					details.push(`**Roles:** ${authStatus.roles.join(', ')}`);
				}
				if (typeof authStatus.tokenExpiresAt === 'number') {
					const expiryDate = new Date(authStatus.tokenExpiresAt);
					details.push(`**Token Expires:** ${expiryDate.toLocaleString()}`);
				}
				if (!authStatus.cloudReachable) {
					details.push(`⚠️ **Cloud Status:** Unreachable`);
				}
			}

			description = `**Account Information (Signed In)**\n\n${details.join('  \n')}`;
		} else {
			description = localize('lucos.account.info.signedOut', "**Account Information:** Not signed in. Use the **Lucos: Sign In** command to authenticate.");
		}

		// Update the configuration property description
		const properties = configRegistry.getConfigurationProperties();
		const accountInfoProperty = properties[LucosSettingId.AccountInfo];
		if (accountInfoProperty) {
			accountInfoProperty.markdownDescription = description;
			configRegistry.notifyConfigurationSchemaUpdated(accountInfoProperty);
		}
	}
}
