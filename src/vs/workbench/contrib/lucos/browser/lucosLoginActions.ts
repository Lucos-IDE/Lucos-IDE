/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { LUCOS_SIGNED_OUT_CONTEXT } from './lucosCommands.js';

const LUCOS_CATEGORY = localize2('lucos', "Lucos");

export class LucosLoginAction extends Action2 {
	static readonly ID = 'lucos.login';
	constructor() {
		super({
			id: LucosLoginAction.ID,
			title: localize2('lucos.login.title', "Sign In"),
			category: LUCOS_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<boolean> {
		return accessor.get(ILucosAuthService).login();
	}
}

export class LucosLogoutAction extends Action2 {
	static readonly ID = 'lucos.logout';
	constructor() {
		super({
			id: LucosLogoutAction.ID,
			title: localize2('lucos.logout.title', "Sign Out"),
			category: LUCOS_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(ILucosAuthService).logout();
	}
}

/**
 * Clears all stored Lucos credentials from the OS keychain and immediately shows the
 * sign-in overlay.  Useful for testing and for switching accounts.
 */
export class LucosResetAuthAction extends Action2 {
	static readonly ID = 'lucos.resetAuth';
	constructor() {
		super({
			id: LucosResetAuthAction.ID,
			title: localize2('lucos.resetAuth.title', "Reset Auth State (Show Sign-in Overlay)"),
			category: LUCOS_CATEGORY,
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(ILucosAuthService);
		const notificationService = accessor.get(INotificationService);
		await authService.logout();
		notificationService.notify({
			severity: Severity.Info,
			message: 'Lucos auth cleared — sign-in overlay should now be visible.',
		});
	}
}

export class LucosGoogleLoginAction extends Action2 {
	static readonly ID = 'lucos.loginWithGoogle';
	constructor() {
		super({
			id: LucosGoogleLoginAction.ID,
			title: localize2('lucos.loginWithGoogle.title', "Sign In with Google"),
			category: LUCOS_CATEGORY,
			f1: true,
		});
	}
	run(accessor: ServicesAccessor): Promise<boolean> {
		return accessor.get(ILucosAuthService).loginWithGoogle();
	}
}

/** Resumes a stored session on startup by handing any keychain JWT to the daemon. */
export class LucosAuthRestoreContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.lucosAuthRestore';
	constructor(
		@ILucosAuthService lucosAuthService: ILucosAuthService,
	) {
		super();
		void lucosAuthService.restore();
	}
}

/**
 * "Sign In to Lucos" button shown in the title bar when the user is not signed in.
 * Gated by the `lucosSignedOut` context key (set by LucosSignOutContextContribution).
 */
export class LucosSignInTitleBarAction extends Action2 {
	static readonly ID = 'lucos.signInTitleBar';
	constructor() {
		super({
			id: LucosSignInTitleBarAction.ID,
			title: localize2('lucos.signInTitleBar.title', "Sign In to Lucos"),
			f1: false,
			menu: [{
				id: MenuId.TitleBarAdjacentCenter,
				order: 1,
				when: LUCOS_SIGNED_OUT_CONTEXT,
			}],
		});
	}
	override run(accessor: ServicesAccessor): Promise<boolean> {
		return accessor.get(ILucosAuthService).loginWithGoogle();
	}
}

/**
 * Keeps the `lucosSignedOut` context key in sync with the Lucos auth service so the
 * title bar "Sign In" button appears/disappears reactively.
 */
export class LucosSignOutContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.lucosSignOutContext';
	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILucosAuthService lucosAuthService: ILucosAuthService,
	) {
		super();
		const key = LUCOS_SIGNED_OUT_CONTEXT.bindTo(contextKeyService);
		key.set(!lucosAuthService.isSignedIn);
		this._register(lucosAuthService.onDidChangeSignInState(signedIn => key.set(!signedIn)));
	}
}
