/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';

/** Command that can be called from anywhere to open the Lucos sign-in overlay. */
export const LUCOS_SHOW_SIGN_IN_OVERLAY_COMMAND_ID = 'lucos.showSignInOverlay';

const PASSWORD_COMPLEXITY_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,100}$/;

function validatePassword(password: string): string | null {
	if (password.length < 8) {
		return localize('lucos.password.err.min', "Password must be at least 8 characters.");
	}
	if (password.length > 100) {
		return localize('lucos.password.err.max', "Password must be at most 100 characters.");
	}
	if (!PASSWORD_COMPLEXITY_REGEX.test(password)) {
		return localize('lucos.password.err.complexity', "Password must include uppercase, lowercase, a digit, and a special character.");
	}
	return null;
}

/**
 * Cursor-like full-window sign-in overlay.  Covers the entire workbench with a branded
 * sign-in screen whenever the user is not authenticated.  Hides automatically via
 * {@link ILucosAuthService.onDidChangeSignInState} as soon as sign-in completes.
 */
export class LucosSignInOverlayContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosSignInOverlay';

	private readonly overlay: HTMLElement;
	private _resetOverlay: (() => void) | undefined;
	private closeButton: HTMLButtonElement | undefined;

	constructor(
		@ILucosAuthService private readonly authService: ILucosAuthService,
		@ILogService private readonly logService: ILogService,
		@ILayoutService private readonly layoutService: ILayoutService,
	) {
		super();
		this.logService.info('[LucosSignIn] overlay contribution created, waiting for session restore…');
		this.overlay = this.buildOverlay(); // starts hidden
		this._register(CommandsRegistry.registerCommand(LUCOS_SHOW_SIGN_IN_OVERLAY_COMMAND_ID, () => {
			this.setVisible(true);
		}));
		// Wait for session restore to complete before deciding to show — prevents flicker
		// where a returning user's JWT is in the keychain but restore() hasn't resolved yet.
		void authService.restorePromise.then(() => {
			const signedIn = authService.isSignedIn;
			const user = authService.signedInUser;
			this.logService.info('[LucosSignIn] session restore complete —',
				`isSignedIn=${signedIn}`,
				`email=${user?.email ?? '(none)'}`,
				`userId=${user?.userId ?? '(none)'}`,
			);
			if (!signedIn) {
				this.logService.info('[LucosSignIn] no stored session → showing sign-in overlay');
				this.setVisible(true);
			} else {
				this.logService.info('[LucosSignIn] stored session found → overlay stays hidden');
			}
		});
		this._register(authService.onDidChangeSignInState(signedIn => {
			this.logService.info(`[LucosSignIn] auth state changed → isSignedIn=${signedIn}, overlay visible=${!signedIn}`);
			if (!signedIn) {
				this._resetOverlay?.();
			}
			this.setVisible(!signedIn);
		}));
		this._register({ dispose: () => this.overlay.remove() });
	}

	private setVisible(visible: boolean): void {
		this.logService.info(`[LucosSignIn] setVisible(${visible})`);
		this.overlay.style.display = visible ? 'flex' : 'none';
		// Show a cancel button only when the overlay is opened while the user is already signed
		// in (e.g. "Switch Account" scenario). When not signed in the overlay must be completed.
		if (this.closeButton) {
			this.closeButton.style.display = (visible && this.authService.isSignedIn) ? 'flex' : 'none';
		}
	}

	private buildOverlay(): HTMLElement {
		this.logService.info('[LucosSignIn] building overlay DOM');

		const overlay = document.createElement('div');
		Object.assign(overlay.style, {
			position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
			zIndex: '99999', display: 'none', alignItems: 'center', justifyContent: 'center',
			background: 'var(--vscode-sideBar-background)',
			color: 'var(--vscode-foreground)',
		});

		// Card
		const card = dom.append(overlay, document.createElement('div'));
		Object.assign(card.style, {
			position: 'relative',
			background: 'var(--vscode-editorWidget-background)',
			border: '1px solid var(--vscode-widget-border, rgba(127,127,127,0.2))',
			borderRadius: '16px', boxShadow: '0 24px 64px var(--vscode-widget-shadow, rgba(0,0,0,0.3))',
			width: '400px', maxHeight: '92vh', overflowY: 'auto',
			padding: '36px 32px', boxSizing: 'border-box',
			display: 'flex', flexDirection: 'column',
		});

		// Cancel button — shown only when the overlay is opened while already signed in
		// (e.g. after clicking "Switch Account"). Hidden when sign-in is required.
		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.setAttribute('aria-label', localize('lucos.signIn.cancel', "Cancel"));
		Object.assign(closeBtn.style, {
			position: 'absolute', top: '14px', right: '14px',
			display: 'none', alignItems: 'center', justifyContent: 'center',
			width: '28px', height: '28px', borderRadius: '6px',
			background: 'none', border: 'none', cursor: 'pointer',
			color: 'var(--vscode-descriptionForeground)',
			padding: '0', fontSize: '18px', lineHeight: '1', fontFamily: 'inherit',
		});
		closeBtn.textContent = '\u00D7';
		closeBtn.title = localize('lucos.signIn.cancelTooltip', "Cancel — stay signed in as current user");
		this._register(dom.addDisposableListener(closeBtn, 'mouseover', () => {
			closeBtn.style.background = 'var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.1))';
			closeBtn.style.color = 'var(--vscode-foreground)';
		}));
		this._register(dom.addDisposableListener(closeBtn, 'mouseout', () => {
			closeBtn.style.background = 'none';
			closeBtn.style.color = 'var(--vscode-descriptionForeground)';
		}));
		this._register(dom.addDisposableListener(closeBtn, 'click', () => {
			this.logService.info('[LucosSignIn] cancel button clicked — hiding overlay');
			this.setVisible(false);
		}));
		card.appendChild(closeBtn);
		this.closeButton = closeBtn;

		// --- Shared helpers --------------------------------------------------

		/** Builds the four-color Google "G" SVG logo. */
		const googleIconSvg = (): SVGSVGElement => {
			const ns = 'http://www.w3.org/2000/svg';
			const svg = document.createElementNS(ns, 'svg') as SVGSVGElement;
			svg.setAttribute('viewBox', '0 0 24 24');
			svg.setAttribute('width', '18'); svg.setAttribute('height', '18');
			svg.style.flexShrink = '0';
			const shapes: [string, string][] = [
				['#4285F4', 'M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z'],
				['#34A853', 'M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z'],
				['#FBBC05', 'M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z'],
				['#EA4335', 'M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z'],
			];
			for (const [fill, d] of shapes) {
				const p = document.createElementNS(ns, 'path');
				p.setAttribute('fill', fill); p.setAttribute('d', d);
				svg.appendChild(p);
			}
			return svg;
		};

		const buildGoogleBtn = (label: string): HTMLButtonElement => {
			const btn = document.createElement('button');
			btn.type = 'button';
			Object.assign(btn.style, {
				display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
				width: '100%', padding: '11px 16px', borderRadius: '8px', cursor: 'pointer',
				background: 'var(--vscode-button-secondaryBackground)',
				color: 'var(--vscode-button-secondaryForeground)',
				border: '1.5px solid var(--vscode-button-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)))',
				fontSize: '14px', fontWeight: '500', fontFamily: 'inherit', outline: 'none',
			});
			btn.appendChild(googleIconSvg());
			const span = document.createElement('span');
			span.textContent = label;
			btn.appendChild(span);
			btn.addEventListener('mouseover', () => { btn.style.background = 'var(--vscode-button-secondaryHoverBackground)'; });
			btn.addEventListener('mouseout', () => { btn.style.background = 'var(--vscode-button-secondaryBackground)'; });
			btn.addEventListener('click', () => {
				this.logService.info('[LucosSignIn] Google button clicked');
				void this.authService.loginWithGoogle();
			});
			return btn;
		};

		const buildDivider = (text: string): HTMLElement => {
			const row = document.createElement('div');
			Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '10px', margin: '18px 0' });
			const line = () => { const l = document.createElement('div'); Object.assign(l.style, { flex: '1', height: '1px', background: 'var(--vscode-editorGroup-border)' }); return l; };
			const lbl = document.createElement('span');
			lbl.textContent = text;
			Object.assign(lbl.style, { fontSize: '12px', color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' });
			row.appendChild(line()); row.appendChild(lbl); row.appendChild(line());
			return row;
		};

		const makeInput = (parent: HTMLElement, labelText: string, type: string, placeholder: string, autocomplete?: string) => {
			const wrap = document.createElement('div');
			Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '14px' });
			const lbl = document.createElement('label');
			lbl.textContent = labelText;
			Object.assign(lbl.style, { fontSize: '13px', fontWeight: '500', color: 'var(--vscode-foreground)' });
			wrap.appendChild(lbl);
			const input = document.createElement('input');
			input.type = type; input.placeholder = placeholder;
			if (autocomplete) { input.setAttribute('autocomplete', autocomplete); }
			Object.assign(input.style, {
				padding: '10px 12px', borderRadius: '8px', fontSize: '13px', outline: 'none',
				border: '1.5px solid var(--vscode-input-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)))',
				background: 'var(--vscode-input-background)',
				color: 'var(--vscode-input-foreground)',
				width: '100%', boxSizing: 'border-box', fontFamily: 'inherit',
			});
			input.addEventListener('focus', () => { input.style.borderColor = 'var(--vscode-focusBorder)'; input.style.outline = '1px solid var(--vscode-focusBorder)'; });
			input.addEventListener('blur', () => { input.style.borderColor = 'var(--vscode-input-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)))'; input.style.outline = 'none'; });
			wrap.appendChild(input);
			parent.appendChild(wrap);
			return { wrap, input };
		};

		const makePasswordInput = (parent: HTMLElement, labelText: string, placeholder: string, autocomplete?: string) => {
			const { wrap, input } = makeInput(parent, labelText, 'password', placeholder, autocomplete);
			input.style.paddingRight = '42px';
			const inputWrap = document.createElement('div');
			Object.assign(inputWrap.style, { position: 'relative', width: '100%' });
			wrap.removeChild(input);
			inputWrap.appendChild(input);
			const eye = document.createElement('button');
			eye.type = 'button';
			Object.assign(eye.style, {
				position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
				background: 'none', border: 'none', cursor: 'pointer', padding: '3px',
				color: 'var(--vscode-descriptionForeground)',
				display: 'flex', alignItems: 'center',
			});
			const eyeSpan = document.createElement('span');
			eyeSpan.className = 'codicon codicon-eye';
			Object.assign(eyeSpan.style, { fontSize: '14px' });
			eye.appendChild(eyeSpan);
			eye.addEventListener('click', () => {
				const shown = input.type === 'text';
				input.type = shown ? 'password' : 'text';
				eyeSpan.className = shown ? 'codicon codicon-eye' : 'codicon codicon-eye-closed';
			});
			inputWrap.appendChild(eye);
			wrap.appendChild(inputWrap);
			return { wrap, input };
		};

		const makeSubmitBtn = (parent: HTMLElement, label: string): HTMLButtonElement => {
			const btn = document.createElement('button');
			btn.type = 'button'; btn.textContent = label;
			Object.assign(btn.style, {
				width: '100%', padding: '12px 0', borderRadius: '8px', border: 'none',
				background: 'linear-gradient(90deg, #6366f1 0%, #06b6d4 100%)',
				color: '#ffffff', fontSize: '14px', fontWeight: '600',
				cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.3px',
			});
			btn.addEventListener('mouseover', () => { btn.style.opacity = '0.88'; });
			btn.addEventListener('mouseout', () => { btn.style.opacity = '1'; });
			parent.appendChild(btn);
			return btn;
		};

		const makeErrorEl = (parent: HTMLElement): HTMLElement => {
			const el = document.createElement('div');
			Object.assign(el.style, { fontSize: '12px', color: 'var(--vscode-errorForeground)', display: 'none', lineHeight: '1.4', marginBottom: '10px' });
			parent.appendChild(el);
			return el;
		};

		const setError = (el: HTMLElement, msg: string) => { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; };

		const setSubmitting = (btn: HTMLButtonElement, inputs: HTMLInputElement[], loading: boolean, loadingLabel?: string, restoreLabel?: string) => {
			btn.disabled = loading;
			btn.style.opacity = loading ? '0.6' : '1';
			if (loading && loadingLabel) { btn.textContent = loadingLabel; }
			if (!loading && restoreLabel) { btn.textContent = restoreLabel; }
			for (const inp of inputs) { inp.disabled = loading; }
		};

		// --- Logo header (shared) -------------------------------------------
		const logoRow = dom.append(card, document.createElement('div'));
		Object.assign(logoRow.style, { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '28px' });
		const logoBox = dom.append(logoRow, document.createElement('div'));
		Object.assign(logoBox.style, {
			width: '30px', height: '30px', borderRadius: '7px',
			background: 'linear-gradient(135deg, #6366f1 0%, #06b6d4 100%)',
			display: 'flex', alignItems: 'center', justifyContent: 'center',
			fontSize: '15px', color: '#fff',
		});
		// allow-any-unicode-next-line
		logoBox.textContent = '✦';
		const logoText = dom.append(logoRow, document.createElement('div'));
		logoText.textContent = 'LUCOS';
		Object.assign(logoText.style, { fontSize: '15px', fontWeight: '700', letterSpacing: '2px', color: 'var(--vscode-foreground)' });

		// === SIGN UP PANEL (default) =========================================
		const signUpPanel = dom.append(card, document.createElement('div'));
		Object.assign(signUpPanel.style, { display: 'flex', flexDirection: 'column' });

		const suTitle = dom.append(signUpPanel, document.createElement('div'));
		suTitle.textContent = localize('lucos.signUp.title', "Create your account");
		Object.assign(suTitle.style, { fontSize: '20px', fontWeight: '700', color: 'var(--vscode-foreground)', marginBottom: '4px' });

		const suSubtitle = dom.append(signUpPanel, document.createElement('div'));
		suSubtitle.textContent = localize('lucos.signUp.subtitle', "Get started with lucos.com in seconds.");
		Object.assign(suSubtitle.style, { fontSize: '13px', color: 'var(--vscode-descriptionForeground)', marginBottom: '20px' });

		signUpPanel.appendChild(buildGoogleBtn(localize('lucos.signUp.google', "Sign up with Google")));
		signUpPanel.appendChild(buildDivider(localize('lucos.signUp.or', "or sign up with email")));

		const { input: suNameInput } = makeInput(signUpPanel, localize('lucos.signUp.name', "Full name"), 'text', 'Jane Doe', 'name');
		const { input: suEmailInput } = makeInput(signUpPanel, localize('lucos.signUp.workEmail', "Work email"), 'email', 'you@company.com', 'email');
		const { input: suPasswordInput } = makePasswordInput(signUpPanel, localize('lucos.signUp.password', "Password"), localize('lucos.signUp.passwordHint', "8+ chars, upper, lower, digit & symbol"), 'new-password');

		// Terms row
		const termsRow = document.createElement('div');
		Object.assign(termsRow.style, { display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '18px' });
		const termsCheck = document.createElement('input');
		termsCheck.type = 'checkbox';
		Object.assign(termsCheck.style, { marginTop: '2px', cursor: 'pointer', flexShrink: '0', accentColor: '#6366f1' });
		const termsLbl = document.createElement('span');
		termsLbl.textContent = localize('lucos.signUp.terms', "I agree to the Terms & Privacy Policy");
		Object.assign(termsLbl.style, { fontSize: '12px', color: 'var(--vscode-descriptionForeground)', lineHeight: '1.5' });
		termsRow.appendChild(termsCheck); termsRow.appendChild(termsLbl);
		signUpPanel.appendChild(termsRow);

		const suError = makeErrorEl(signUpPanel);
		const suBtn = makeSubmitBtn(signUpPanel, localize('lucos.signUp.submit', "Create account"));
		suBtn.style.marginBottom = '18px';

		const suFooter = dom.append(signUpPanel, document.createElement('div'));
		Object.assign(suFooter.style, { textAlign: 'center', fontSize: '13px', color: 'var(--vscode-descriptionForeground)' });
		suFooter.appendChild(document.createTextNode(localize('lucos.signUp.haveAccount', "Already have an account? ")));
		const suSignInLink = document.createElement('span');
		suSignInLink.textContent = localize('lucos.signUp.signInLink', "Sign in");
		Object.assign(suSignInLink.style, { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', fontWeight: '600' });
		suFooter.appendChild(suSignInLink);

		// === SIGN IN PANEL ===================================================
		const signInPanel = dom.append(card, document.createElement('div'));
		Object.assign(signInPanel.style, { display: 'none', flexDirection: 'column' });

		const siTitle = dom.append(signInPanel, document.createElement('div'));
		siTitle.textContent = localize('lucos.signIn.pageTitle', "Welcome back");
		Object.assign(siTitle.style, { fontSize: '20px', fontWeight: '700', color: 'var(--vscode-foreground)', marginBottom: '4px' });

		const siSubtitle = dom.append(signInPanel, document.createElement('div'));
		siSubtitle.textContent = localize('lucos.signIn.pageSubtitle', "Sign in to your Lucos account");
		Object.assign(siSubtitle.style, { fontSize: '13px', color: 'var(--vscode-descriptionForeground)', marginBottom: '20px' });

		signInPanel.appendChild(buildGoogleBtn(localize('lucos.signIn.google', "Sign in with Google")));
		signInPanel.appendChild(buildDivider(localize('lucos.signIn.or', "or sign in with email")));

		const { input: siEmailInput } = makeInput(signInPanel, localize('lucos.signIn.email', "Email"), 'email', 'you@company.com', 'email');
		const { input: siPasswordInput } = makePasswordInput(signInPanel, localize('lucos.signIn.password', "Password"), 'Your password', 'current-password');

		const forgotRow = document.createElement('div');
		Object.assign(forgotRow.style, { display: 'flex', justifyContent: 'flex-end', marginTop: '-6px', marginBottom: '14px' });
		const forgotLink = document.createElement('span');
		forgotLink.textContent = localize('lucos.signIn.forgotPassword', "Forgot password?");
		Object.assign(forgotLink.style, { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', fontSize: '12px', fontWeight: '600' });
		forgotRow.appendChild(forgotLink);
		signInPanel.appendChild(forgotRow);

		const siError = makeErrorEl(signInPanel);
		const siSuccess = document.createElement('div');
		Object.assign(siSuccess.style, { fontSize: '12px', color: 'var(--vscode-charts-green, #22c55e)', display: 'none', lineHeight: '1.4', marginBottom: '10px' });
		signInPanel.appendChild(siSuccess);
		const setSuccess = (msg: string) => { siSuccess.textContent = msg; siSuccess.style.display = msg ? 'block' : 'none'; };

		const siBtn = makeSubmitBtn(signInPanel, localize('lucos.signIn.submit', "Sign In"));
		siBtn.style.marginBottom = '18px';

		const siFooter = dom.append(signInPanel, document.createElement('div'));
		Object.assign(siFooter.style, { textAlign: 'center', fontSize: '13px', color: 'var(--vscode-descriptionForeground)' });
		siFooter.appendChild(document.createTextNode(localize('lucos.signIn.noAccount', "Don't have an account? ")));
		const siSignUpLink = document.createElement('span');
		siSignUpLink.textContent = localize('lucos.signIn.signUpLink', "Sign up");
		Object.assign(siSignUpLink.style, { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', fontWeight: '600' });
		siFooter.appendChild(siSignUpLink);

		// === VERIFY EMAIL PANEL (OTP after sign-up) ==========================
		const verifyPanel = dom.append(card, document.createElement('div'));
		Object.assign(verifyPanel.style, { display: 'none', flexDirection: 'column' });

		const veTitle = dom.append(verifyPanel, document.createElement('div'));
		veTitle.textContent = localize('lucos.verify.title', "Check your email");
		Object.assign(veTitle.style, { fontSize: '20px', fontWeight: '700', color: 'var(--vscode-foreground)', marginBottom: '4px' });

		const veSubtitle = dom.append(verifyPanel, document.createElement('div'));
		veSubtitle.textContent = localize('lucos.verify.subtitle', "Enter the 6-digit code we sent you.");
		Object.assign(veSubtitle.style, { fontSize: '13px', color: 'var(--vscode-descriptionForeground)', marginBottom: '20px' });

		const { input: veOtpInput } = makeInput(verifyPanel, localize('lucos.verify.code', "Verification code"), 'text', '123456', 'one-time-code');
		veOtpInput.maxLength = 6;
		veOtpInput.inputMode = 'numeric';
		veOtpInput.pattern = '[0-9]*';
		veOtpInput.style.letterSpacing = '4px';
		veOtpInput.style.fontSize = '18px';
		veOtpInput.style.textAlign = 'center';

		const veError = makeErrorEl(verifyPanel);
		const veBtn = makeSubmitBtn(verifyPanel, localize('lucos.verify.submit', "Verify & continue"));
		veBtn.style.marginBottom = '12px';

		const veResend = document.createElement('button');
		veResend.type = 'button';
		veResend.textContent = localize('lucos.verify.resend', "Resend code");
		Object.assign(veResend.style, {
			width: '100%', padding: '10px 0', borderRadius: '8px', cursor: 'pointer',
			background: 'transparent', border: '1px solid var(--vscode-button-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)))',
			color: 'var(--vscode-foreground)', fontSize: '13px', fontFamily: 'inherit', marginBottom: '18px',
		});
		verifyPanel.appendChild(veResend);

		const veFooter = dom.append(verifyPanel, document.createElement('div'));
		Object.assign(veFooter.style, { textAlign: 'center', fontSize: '13px', color: 'var(--vscode-descriptionForeground)' });
		veFooter.appendChild(document.createTextNode(localize('lucos.verify.wrongEmail', "Wrong email? ")));
		const veBackLink = document.createElement('span');
		veBackLink.textContent = localize('lucos.verify.back', "Go back");
		Object.assign(veBackLink.style, { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', fontWeight: '600' });
		veFooter.appendChild(veBackLink);

		let pendingVerifyEmail = '';

		// === RESET PASSWORD PANEL ============================================
		const resetPanel = dom.append(card, document.createElement('div'));
		Object.assign(resetPanel.style, { display: 'none', flexDirection: 'column' });

		const rpTitle = dom.append(resetPanel, document.createElement('div'));
		rpTitle.textContent = localize('lucos.reset.title', "Reset your password");
		Object.assign(rpTitle.style, { fontSize: '20px', fontWeight: '700', color: 'var(--vscode-foreground)', marginBottom: '4px' });

		const rpSubtitle = dom.append(resetPanel, document.createElement('div'));
		rpSubtitle.textContent = localize('lucos.reset.subtitle', "Enter the 6-digit code we sent you, then choose a new password.");
		Object.assign(rpSubtitle.style, { fontSize: '13px', color: 'var(--vscode-descriptionForeground)', marginBottom: '20px' });

		const { input: rpEmailInput } = makeInput(resetPanel, localize('lucos.reset.email', "Email"), 'email', 'you@company.com', 'email');
		const { input: rpOtpInput } = makeInput(resetPanel, localize('lucos.reset.code', "Reset code"), 'text', '123456', 'one-time-code');
		rpOtpInput.maxLength = 6;
		rpOtpInput.inputMode = 'numeric';
		rpOtpInput.pattern = '[0-9]*';
		rpOtpInput.style.letterSpacing = '4px';
		rpOtpInput.style.fontSize = '18px';
		rpOtpInput.style.textAlign = 'center';

		const { input: rpPasswordInput } = makePasswordInput(resetPanel, localize('lucos.reset.password', "New password"), localize('lucos.signUp.passwordHint', "8+ chars, upper, lower, digit & symbol"), 'new-password');

		const rpError = makeErrorEl(resetPanel);
		const rpBtn = makeSubmitBtn(resetPanel, localize('lucos.reset.submit', "Reset password"));
		rpBtn.style.marginBottom = '12px';

		const rpResend = document.createElement('button');
		rpResend.type = 'button';
		rpResend.textContent = localize('lucos.reset.resend', "Resend code");
		Object.assign(rpResend.style, {
			width: '100%', padding: '10px 0', borderRadius: '8px', cursor: 'pointer',
			background: 'transparent', border: '1px solid var(--vscode-button-border, var(--vscode-widget-border, rgba(127, 127, 127, 0.35)))',
			color: 'var(--vscode-foreground)', fontSize: '13px', fontFamily: 'inherit', marginBottom: '18px',
		});
		resetPanel.appendChild(rpResend);

		const rpFooter = dom.append(resetPanel, document.createElement('div'));
		Object.assign(rpFooter.style, { textAlign: 'center', fontSize: '13px', color: 'var(--vscode-descriptionForeground)' });
		rpFooter.appendChild(document.createTextNode(localize('lucos.reset.remember', "Remember your password? ")));
		const rpBackLink = document.createElement('span');
		rpBackLink.textContent = localize('lucos.reset.back', "Back to sign in");
		Object.assign(rpBackLink.style, { color: 'var(--vscode-textLink-foreground)', cursor: 'pointer', fontWeight: '600' });
		rpFooter.appendChild(rpBackLink);

		let pendingResetEmail = '';

		// --- Panel switch ----------------------------------------------------
		const showOnly = (panel: HTMLElement) => {
			signUpPanel.style.display = panel === signUpPanel ? 'flex' : 'none';
			signInPanel.style.display = panel === signInPanel ? 'flex' : 'none';
			verifyPanel.style.display = panel === verifyPanel ? 'flex' : 'none';
			resetPanel.style.display = panel === resetPanel ? 'flex' : 'none';
		};
		const showSignUp = () => { showOnly(signUpPanel); setError(suError, ''); };
		const showSignIn = (successMsg?: string) => {
			showOnly(signInPanel);
			setError(siError, '');
			setSuccess(successMsg ?? '');
		};
		const showVerify = (email: string, message?: string) => {
			pendingVerifyEmail = email;
			veSubtitle.textContent = message
				|| localize('lucos.verify.subtitleEmail', "Enter the 6-digit code sent to {0}.", email);
			veOtpInput.value = '';
			setError(veError, '');
			showOnly(verifyPanel);
			veOtpInput.focus();
		};
		const showReset = (email: string, message?: string) => {
			pendingResetEmail = email;
			rpEmailInput.value = email;
			rpOtpInput.value = '';
			rpPasswordInput.value = '';
			rpSubtitle.textContent = message
				|| localize('lucos.reset.subtitleEmail', "Enter the 6-digit code sent to {0}, then choose a new password.", email);
			setError(rpError, '');
			showOnly(resetPanel);
			rpOtpInput.focus();
		};
		this._register(dom.addDisposableListener(suSignInLink, 'click', () => showSignIn()));
		this._register(dom.addDisposableListener(siSignUpLink, 'click', showSignUp));
		this._register(dom.addDisposableListener(veBackLink, 'click', showSignUp));
		this._register(dom.addDisposableListener(rpBackLink, 'click', () => showSignIn()));

		this._resetOverlay = () => {
			suNameInput.value = '';
			suEmailInput.value = '';
			suPasswordInput.value = '';
			termsCheck.checked = false;
			siEmailInput.value = '';
			siPasswordInput.value = '';
			veOtpInput.value = '';
			rpEmailInput.value = '';
			rpOtpInput.value = '';
			rpPasswordInput.value = '';
			pendingVerifyEmail = '';
			pendingResetEmail = '';
			setError(suError, '');
			setError(siError, '');
			setError(veError, '');
			setError(rpError, '');
			setSuccess('');
			setSubmitting(suBtn, [suNameInput, suEmailInput, suPasswordInput], false, undefined, localize('lucos.signUp.submit', "Create account"));
			setSubmitting(siBtn, [siEmailInput, siPasswordInput], false, undefined, localize('lucos.signIn.submit', "Sign In"));
			setSubmitting(veBtn, [veOtpInput], false, undefined, localize('lucos.verify.submit', "Verify & continue"));
			veResend.disabled = false;
			setSubmitting(rpBtn, [rpEmailInput, rpOtpInput, rpPasswordInput], false, undefined, localize('lucos.reset.submit', "Reset password"));
			rpResend.disabled = false;
			showSignIn();
		};

		// --- Sign Up submit --------------------------------------------------
		suBtn.addEventListener('click', async () => {
			const name = suNameInput.value.trim();
			const email = suEmailInput.value.trim();
			const password = suPasswordInput.value;
			setError(suError, '');
			if (!name) { setError(suError, localize('lucos.signUp.err.name', "Please enter your full name.")); return; }
			if (!email) { setError(suError, localize('lucos.signUp.err.email', "Please enter your email address.")); return; }
			if (!password) { setError(suError, localize('lucos.signUp.err.password', "Please enter a password.")); return; }
			const passwordErr = validatePassword(password);
			if (passwordErr) { setError(suError, passwordErr); return; }
			if (!termsCheck.checked) { setError(suError, localize('lucos.signUp.err.terms', "Please agree to the Terms & Privacy Policy.")); return; }

			setSubmitting(suBtn, [suNameInput, suEmailInput, suPasswordInput], true, localize('lucos.loading', "Please wait\u2026"));
			try {
				this.logService.info('[LucosSignIn] submitting registration', `email=${email}`);
				const result = await this.authService.register(email, password, name);
				if (this.authService.isSignedIn) {
					// Legacy gateway returned a JWT immediately.
					return;
				}
				showVerify(result.email, result.message);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.error('[LucosSignIn] registration failed:', msg);
				setError(suError, msg);
			} finally {
				setSubmitting(suBtn, [suNameInput, suEmailInput, suPasswordInput], false, undefined, localize('lucos.signUp.submit', "Create account"));
			}
		});

		// --- Verify OTP submit -----------------------------------------------
		veBtn.addEventListener('click', async () => {
			const otp = veOtpInput.value.trim();
			setError(veError, '');
			if (!/^\d{6}$/.test(otp)) {
				setError(veError, localize('lucos.verify.err.otp', "Enter the 6-digit code from your email."));
				return;
			}
			setSubmitting(veBtn, [veOtpInput], true, localize('lucos.loading', "Please wait\u2026"));
			veResend.disabled = true;
			try {
				this.logService.info('[LucosSignIn] verifying signup OTP', `email=${pendingVerifyEmail}`);
				await this.authService.verifySignupEmail(pendingVerifyEmail, otp);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.error('[LucosSignIn] verify failed:', msg);
				setError(veError, msg);
			} finally {
				setSubmitting(veBtn, [veOtpInput], false, undefined, localize('lucos.verify.submit', "Verify & continue"));
				veResend.disabled = false;
			}
		});

		veResend.addEventListener('click', async () => {
			if (!pendingVerifyEmail) {
				return;
			}
			setError(veError, '');
			veResend.disabled = true;
			try {
				await this.authService.resendSignupOtp(pendingVerifyEmail);
				veSubtitle.textContent = localize('lucos.verify.resent', "A new code was sent to {0}.", pendingVerifyEmail);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				setError(veError, msg);
			} finally {
				veResend.disabled = false;
			}
		});

		// --- Forgot password -------------------------------------------------
		forgotLink.addEventListener('click', async () => {
			const email = siEmailInput.value.trim() || rpEmailInput.value.trim();
			setError(siError, '');
			setSuccess('');
			if (!email) {
				setError(siError, localize('lucos.reset.err.email', "Enter your email address, then tap Forgot password."));
				siEmailInput.focus();
				return;
			}
			setSubmitting(siBtn, [siEmailInput, siPasswordInput], true, localize('lucos.loading', "Please wait\u2026"));
			forgotLink.style.pointerEvents = 'none';
			try {
				this.logService.info('[LucosSignIn] requesting password reset OTP', `email=${email}`);
				await this.authService.forgotPassword(email);
				showReset(email, localize('lucos.reset.sent', "A reset code was sent to {0}.", email));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.error('[LucosSignIn] forgot password failed:', msg);
				setError(siError, msg);
			} finally {
				setSubmitting(siBtn, [siEmailInput, siPasswordInput], false, undefined, localize('lucos.signIn.submit', "Sign In"));
				forgotLink.style.pointerEvents = '';
			}
		});

		rpBtn.addEventListener('click', async () => {
			const email = rpEmailInput.value.trim() || pendingResetEmail;
			const otp = rpOtpInput.value.trim();
			const password = rpPasswordInput.value;
			setError(rpError, '');
			if (!email) { setError(rpError, localize('lucos.reset.err.emailRequired', "Please enter your email address.")); return; }
			if (!/^\d{6}$/.test(otp)) {
				setError(rpError, localize('lucos.reset.err.otp', "Enter the 6-digit code from your email."));
				return;
			}
			if (!password) { setError(rpError, localize('lucos.reset.err.password', "Please enter a new password.")); return; }
			const passwordErr = validatePassword(password);
			if (passwordErr) { setError(rpError, passwordErr); return; }

			setSubmitting(rpBtn, [rpEmailInput, rpOtpInput, rpPasswordInput], true, localize('lucos.loading', "Please wait\u2026"));
			rpResend.disabled = true;
			try {
				this.logService.info('[LucosSignIn] submitting password reset', `email=${email}`);
				await this.authService.resetPassword(email, otp, password);
				showSignIn(localize('lucos.reset.success', "Password updated. Sign in with your new password."));
				siEmailInput.value = email;
				siPasswordInput.value = '';
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.error('[LucosSignIn] reset password failed:', msg);
				setError(rpError, msg);
			} finally {
				setSubmitting(rpBtn, [rpEmailInput, rpOtpInput, rpPasswordInput], false, undefined, localize('lucos.reset.submit', "Reset password"));
				rpResend.disabled = false;
			}
		});

		rpResend.addEventListener('click', async () => {
			const email = rpEmailInput.value.trim() || pendingResetEmail;
			if (!email) {
				setError(rpError, localize('lucos.reset.err.emailRequired', "Please enter your email address."));
				return;
			}
			setError(rpError, '');
			rpResend.disabled = true;
			try {
				await this.authService.forgotPassword(email);
				pendingResetEmail = email;
				rpSubtitle.textContent = localize('lucos.reset.resent', "A new reset code was sent to {0}.", email);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				setError(rpError, msg);
			} finally {
				rpResend.disabled = false;
			}
		});

		// --- Sign In submit --------------------------------------------------
		siBtn.addEventListener('click', async () => {
			const email = siEmailInput.value.trim();
			const password = siPasswordInput.value;
			setError(siError, '');
			setSuccess('');
			if (!email) { setError(siError, localize('lucos.signIn.err.email', "Please enter your email address.")); return; }
			if (!password) { setError(siError, localize('lucos.signIn.err.password', "Please enter your password.")); return; }

			setSubmitting(siBtn, [siEmailInput, siPasswordInput], true, localize('lucos.loading', "Please wait\u2026"));
			try {
				this.logService.info('[LucosSignIn] submitting email sign-in', `email=${email}`);
				await this.authService.loginWithEmail(email, password);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.logService.error('[LucosSignIn] sign-in failed:', msg);
				setError(siError, msg);
			} finally {
				setSubmitting(siBtn, [siEmailInput, siPasswordInput], false, undefined, localize('lucos.signIn.submit', "Sign In"));
			}
		});

		// --- Keyboard navigation ---------------------------------------------
		suNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { suEmailInput.focus(); } });
		suEmailInput.addEventListener('keydown', e => { if (e.key === 'Enter') { suPasswordInput.focus(); } });
		suPasswordInput.addEventListener('keydown', e => { if (e.key === 'Enter') { suBtn.click(); } });
		siEmailInput.addEventListener('keydown', e => { if (e.key === 'Enter') { siPasswordInput.focus(); } });
		siPasswordInput.addEventListener('keydown', e => { if (e.key === 'Enter') { siBtn.click(); } });
		veOtpInput.addEventListener('keydown', e => { if (e.key === 'Enter') { veBtn.click(); } });
		rpEmailInput.addEventListener('keydown', e => { if (e.key === 'Enter') { rpOtpInput.focus(); } });
		rpOtpInput.addEventListener('keydown', e => { if (e.key === 'Enter') { rpPasswordInput.focus(); } });
		rpPasswordInput.addEventListener('keydown', e => { if (e.key === 'Enter') { rpBtn.click(); } });

		// Mount inside the workbench container: the --vscode-* theme variables are defined
		// on .monaco-workbench, so the overlay only follows light/dark themes from there.
		this.layoutService.mainContainer.appendChild(overlay);
		this.logService.info('[LucosSignIn] overlay DOM appended to workbench container');
		return overlay;
	}
}
