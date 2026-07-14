/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { LucosSignInEditorInput } from './lucosSignInEditorInput.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';

export class LucosSignInEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.lucosSignIn';

	private container: HTMLElement | undefined;
	private readonly inputDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ILucosAuthService private readonly lucosAuthService: ILucosAuthService,
	) {
		super(LucosSignInEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		// Use absolute positioning so the container always fills the editor pane area.
		this.container = dom.append(parent, dom.$('div'));
		Object.assign(this.container.style, {
			position: 'absolute',
			inset: '0',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			overflow: 'auto',
			background: 'var(--vscode-editor-background)',
		});
		this.renderPage(this.container);
	}

	override async setInput(
		input: LucosSignInEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		// Auto-close this tab once the user successfully signs in.
		this.inputDisposables.add(this.lucosAuthService.onDidChangeSignInState(signedIn => {
			if (signedIn) {
				this.group.closeEditor(input);
			}
		}));
	}

	override clearInput(): void {
		this.inputDisposables.clear();
		super.clearInput();
	}

	override layout(): void {
		// no-op: CSS flex handles sizing
	}

	private renderPage(container: HTMLElement): void {
		const page = dom.append(container, dom.$('div'));
		Object.assign(page.style, {
			display: 'flex',
			flexDirection: 'column',
			alignItems: 'center',
			gap: '16px',
			maxWidth: '380px',
			width: '100%',
			padding: '48px 32px',
			textAlign: 'center',
			boxSizing: 'border-box',
		});

		// Logo
		const logo = dom.append(page, dom.$('div'));
		logo.textContent = '✨';
		logo.setAttribute('aria-hidden', 'true');
		Object.assign(logo.style, {
			fontSize: '56px',
			lineHeight: '1',
			marginBottom: '4px',
		});

		// Title
		const title = dom.append(page, dom.$('h1'));
		title.textContent = localize('lucos.signIn.heading', "Welcome to Lucos");
		Object.assign(title.style, {
			margin: '0',
			fontSize: '1.7em',
			fontWeight: '600',
			color: 'var(--vscode-foreground)',
			letterSpacing: '-0.3px',
		});

		// Subtitle
		const subtitle = dom.append(page, dom.$('p'));
		subtitle.textContent = localize('lucos.signIn.body', "Your AI-powered coding assistant. Sign in to enable AI chat, workspace indexing, and code generation.");
		Object.assign(subtitle.style, {
			margin: '0',
			fontSize: '0.95em',
			color: 'var(--vscode-descriptionForeground)',
			lineHeight: '1.6',
			maxWidth: '300px',
		});

		// Divider
		const divider = dom.append(page, dom.$('hr'));
		Object.assign(divider.style, {
			width: '100%',
			border: 'none',
			borderTop: '1px solid var(--vscode-widget-border)',
			margin: '4px 0',
		});

		// Buttons
		const buttons = dom.append(page, dom.$('div'));
		Object.assign(buttons.style, {
			display: 'flex',
			flexDirection: 'column',
			gap: '10px',
			width: '100%',
		});

		const googleBtn = this._register(new Button(buttons, {
			...defaultButtonStyles,
			title: localize('lucos.signIn.google', "Continue with Google"),
		}));
		googleBtn.label = localize('lucos.signIn.google', "Continue with Google");
		this._register(googleBtn.onDidClick(() => void this.lucosAuthService.loginWithGoogle()));

		const emailBtn = this._register(new Button(buttons, {
			...defaultButtonStyles,
			secondary: true,
			title: localize('lucos.signIn.email', "Continue with email"),
		}));
		emailBtn.label = localize('lucos.signIn.email', "Continue with email");
		this._register(emailBtn.onDidClick(() => void this.lucosAuthService.login()));
	}
}

