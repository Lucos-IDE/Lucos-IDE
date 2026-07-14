/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Lucos IDE - sign-in on startup (Cursor-like onboarding).
 *
 *  On every startup, if the user has not authenticated, this contribution opens a dedicated
 *  sign-in editor tab in the main editor area and reveals the Lucos sidebar.  The editor tab
 *  closes itself automatically via onDidChangeSignInState once the user signs in.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { LucosSignInEditorInput } from './lucosSignInEditorInput.js';
import { LUCOS_VIEW_CONTAINER_ID } from './lucosCommands.js';

/**
 * Opens the Lucos sign-in editor and reveals the Lucos sidebar on every startup when the
 * user is not authenticated.  The sign-in editor closes itself automatically once the user
 * completes sign-in via {@link ILucosAuthService.onDidChangeSignInState}.
 */
export class LucosSignInOnStartupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosSignInOnStartup';

	constructor(
		@ILucosAuthService private readonly authService: ILucosAuthService,
		@IEditorService private readonly editorService: IEditorService,
		@IViewsService private readonly viewsService: IViewsService,
	) {
		super();
		void this.maybeShowSignIn();
	}

	private async maybeShowSignIn(): Promise<void> {
		if (this.authService.isSignedIn) {
			return;
		}

		// Reveal the Lucos sidebar so the user sees the activity bar context.
		await this.viewsService.openViewContainer(LUCOS_VIEW_CONTAINER_ID, false);

		// Open the dedicated full-screen sign-in editor tab.
		await this.editorService.openEditor(new LucosSignInEditorInput(), {
			pinned: false,
			revealIfOpened: true,
		});
	}
}

