/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Lucos IDE - first-run onboarding prompt (TW-178 / TW-198).
 *
 *  On the very first launch of a fresh install, if the user has not already authenticated,
 *  this contribution shows a dismissible notification that prompts them to sign in.
 *  After a successful sign-in it immediately kicks off workspace indexing so the status bar
 *  transitions Connected -> Indexing -> Ready without any further user action.
 *
 *  "First run" is defined as StorageScope.APPLICATION being new (i.e. no prior application
 *  data exists for this install). Returning users whose JWT was already restored by
 *  LucosAuthRestoreContribution will have a non-Unauthenticated authStatus and are skipped.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexService } from '../common/lucosIndexService.js';
import { LucosAuthState } from '../../../../platform/lucos/common/lucosProtocol.js';

/** Storage key written after the first-run prompt has been shown (so it never re-appears). */
const FIRST_RUN_SHOWN_KEY = 'lucos.firstRun.promptShown';

export class LucosFirstRunContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosFirstRun';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosAuthService private readonly authService: ILucosAuthService,
		@ILucosDaemonService private readonly daemonService: ILucosDaemonService,
		@ILucosIndexService private readonly indexService: ILucosIndexService,
	) {
		super();
		void this.maybePrompt();
	}

	private async maybePrompt(): Promise<void> {
		// Only show once, ever.
		if (this.storageService.getBoolean(FIRST_RUN_SHOWN_KEY, StorageScope.APPLICATION, false)) {
			return;
		}
		// Skip if the user is already authenticated (session was restored on startup).
		if (this.daemonService.authStatus.state !== LucosAuthState.Unauthenticated) {
			return;
		}

		this.storageService.store(FIRST_RUN_SHOWN_KEY, true, StorageScope.APPLICATION, /* target */ 1 /* StorageTarget.MACHINE */);

		this.notificationService.notify({
			severity: Severity.Info,
			message: localize('lucos.firstRun.message', "Sign in to Lucos to enable AI assistance and workspace indexing."),
			actions: {
				primary: [
					new Action(
						'lucos.firstRun.signIn',
						localize('lucos.firstRun.signIn', "Sign In"),
						undefined,
						true,
						async () => {
							const ok = await this.authService.login();
							if (ok) {
								// Kick off indexing immediately after sign-in so the status bar
								// transitions Connected -> Indexing -> Ready automatically.
								void this.indexService.index();
							}
						},
					),
				],
				secondary: [
					new Action(
						'lucos.firstRun.skip',
						localize('lucos.firstRun.skip', "Skip (local-only mode)"),
					),
				],
			},
		});
	}
}
