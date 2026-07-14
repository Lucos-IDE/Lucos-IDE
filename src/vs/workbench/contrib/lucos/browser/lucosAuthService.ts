/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { asJson, IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosAuthService, ILucosSignedInUser } from '../common/lucosAuthService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

/** Keychain key for the cloud access JWT. */
const JWT_SECRET_KEY = 'lucos.cloud.jwt';
/** Keychain key for the opaque refresh token returned by the gateway. */
const REFRESH_TOKEN_KEY = 'lucos.cloud.refreshToken';
/** Keychain key for the signed-in user's ID. */
const USER_ID_KEY = 'lucos.cloud.userId';
/** Keychain key for the signed-in user's email address. */
const USER_EMAIL_KEY = 'lucos.cloud.email';

interface IAuthResponse {
	readonly token?: string;
	readonly accessToken?: string;
	readonly userId?: string;
	readonly orgId?: string;
	readonly user?: { readonly id?: string; readonly orgId?: string };
}

interface IIdeStartResponse {
	readonly success: boolean;
	readonly redirectUrl?: string;
}

export class LucosAuthService extends Disposable implements ILucosAuthService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSignInState = this._register(new Emitter<boolean>());
	readonly onDidChangeSignInState: Event<boolean> = this._onDidChangeSignInState.event;

	private _isSignedIn = false;
	get isSignedIn(): boolean { return this._isSignedIn; }

	private _signedInUser: ILucosSignedInUser | undefined;
	get signedInUser(): ILucosSignedInUser | undefined { return this._signedInUser; }

	private _pendingGoogleResolve: ((success: boolean) => void) | undefined;
	private _pendingGoogleNotification: INotificationHandle | undefined;
	private _pendingGoogleTimeout: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IProductService private readonly productService: IProductService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	/** Updates the in-memory signed-in state and fires the change event. */
	private _setSignedIn(signedIn: boolean, user?: ILucosSignedInUser): void {
		this._isSignedIn = signedIn;
		this._signedInUser = signedIn ? user : undefined;
		this._onDidChangeSignInState.fire(signedIn);
	}

	async login(): Promise<boolean> {
		const email = await this.quickInputService.input({
			prompt: localize('lucos.login.email', "Lucos - email"),
			placeHolder: 'you@example.com',
			ignoreFocusLost: true,
			validateInput: async value => value.includes('@') ? undefined : localize('lucos.login.emailInvalid', "Enter a valid email address."),
		});
		if (!email) {
			return false;
		}

		const password = await this.quickInputService.input({
			prompt: localize('lucos.login.password', "Lucos - password"),
			password: true,
			ignoreFocusLost: true,
		});
		if (!password) {
			return false;
		}

		try {
			const auth = await this.authenticate(email, password);
			await this.secretStorageService.set(JWT_SECRET_KEY, auth.token);
			if (auth.userId) {
				await this.secretStorageService.set(USER_ID_KEY, auth.userId);
			}
			await this.secretStorageService.set(USER_EMAIL_KEY, email);
			try {
				await this.lucosDaemonService.setCloudCredentials({
					accessToken: auth.token,
					userId: auth.userId,
					orgId: auth.orgId,
				});
			} catch (daemonError) {
				this.logService.warn('[LucosAuth] login: daemon unavailable, credentials stored locally only',
					daemonError instanceof Error ? daemonError.message : String(daemonError));
			}
			this._setSignedIn(true, { userId: auth.userId, email });
			this.notificationService.notify({ severity: Severity.Info, message: localize('lucos.login.success', "Signed in to Lucos.") });
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize('lucos.login.failed', "Lucos sign-in failed: {0}", message),
				actions: { primary: [new Action('lucos.login.retry', localize('lucos.login.retry', "Retry"), undefined, true, () => { void this.login(); })] },
			});
			return false;
		}
	}

	async loginWithGoogle(): Promise<boolean> {
		const gatewayUrl = ((this.configurationService.getValue<string>(LucosSettingId.CloudGatewayUrl) ?? '').trim()
			|| (this.productService.lucosGatewayUrl ?? '')).replace(/\/+$/, '');

		this.logService.info('[LucosAuth] loginWithGoogle: starting', `gatewayUrl=${gatewayUrl || '(not set)'}`);

		if (!gatewayUrl) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.loginGoogle.noGateway', "Set `lucos.cloud.gatewayUrl` in settings first.") });
			return false;
		}

		// Cancel any previous pending flow.
		this._cancelPendingGoogle(false);

		try {
			this.logService.trace('[LucosAuth] loginWithGoogle: calling ide-start', `url=${gatewayUrl}/api/v1/auth/google/ide-start`);
			// Ask the gateway to generate a signed Google OAuth URL with state.
			// Pass deepLink so the gateway redirects to our protocol scheme (lucos://)
			// instead of its default (code-oss://).
			const deepLink = encodeURIComponent(`${this.productService.urlProtocol}://auth/callback`);
			const context = await this.requestService.request({
				type: 'GET',
				url: `${gatewayUrl}/api/v1/auth/google/ide-start?deepLink=${deepLink}`,
				callSite: 'lucos.loginGoogle.start',
			}, CancellationToken.None);

			this.logService.trace('[LucosAuth] loginWithGoogle: ide-start responded', `status=${context.res.statusCode}`);

			if (!isSuccess(context)) {
				throw new Error(localize('lucos.loginGoogle.startFailed', "Google sign-in: gateway responded {0}", context.res.statusCode ?? 0));
			}

			const body = await asJson<IIdeStartResponse>(context);
			this.logService.trace('[LucosAuth] loginWithGoogle: ide-start body', `success=${body?.success}`, `hasRedirectUrl=${!!body?.redirectUrl}`);

			if (!body?.success || !body.redirectUrl) {
				throw new Error(localize('lucos.loginGoogle.noRedirect', "Google sign-in: gateway did not return a redirect URL."));
			}

			this.logService.info('[LucosAuth] loginWithGoogle: opening Google consent screen in browser');
			// Open the Google consent screen in the system browser.
			await this.openerService.open(URI.parse(body.redirectUrl), { openExternal: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error('[LucosAuth] loginWithGoogle: failed', message);
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.loginGoogle.startError', "Google sign-in failed: {0}", message) });
			return false;
		}

		this.logService.info('[LucosAuth] loginWithGoogle: browser opened, waiting for lucos://auth/callback deep link...');

		// Show a persistent notification so the user knows what's happening and can cancel.
		this._pendingGoogleNotification = this.notificationService.notify({
			severity: Severity.Info,
			message: localize('lucos.loginGoogle.waiting', "Waiting for Google sign-in in your browser..."),
			actions: {
				primary: [new Action('lucos.loginGoogle.cancel', localize('lucos.loginGoogle.cancelLabel', "Cancel"), undefined, true, () => {
					this.logService.info('[LucosAuth] loginWithGoogle: cancelled by user');
					this._cancelPendingGoogle(false);
				})],
			},
		});

		// Auto-cancel after 5 minutes so the IDE never hangs indefinitely.
		this._pendingGoogleTimeout = setTimeout(() => {
			this.logService.warn('[LucosAuth] loginWithGoogle: timed out after 5 minutes with no callback');
			this.notificationService.notify({ severity: Severity.Warning, message: localize('lucos.loginGoogle.timeout', "Google sign-in timed out. Please try again.") });
			this._cancelPendingGoogle(false);
		}, 5 * 60 * 1000);

		// Suspend until lucos://auth/callback delivers the token (or an error).
		return new Promise<boolean>(resolve => {
			this._pendingGoogleResolve = resolve;
		});
	}

	/** Cleans up all pending Google login state and resolves with the given result. */
	private _cancelPendingGoogle(result: boolean): void {
		this.logService.trace('[LucosAuth] _cancelPendingGoogle', `result=${result}`);
		clearTimeout(this._pendingGoogleTimeout);
		this._pendingGoogleTimeout = undefined;
		this._pendingGoogleNotification?.close();
		this._pendingGoogleNotification = undefined;
		this._pendingGoogleResolve?.(result);
		this._pendingGoogleResolve = undefined;
	}

	async completeGoogleLogin(token: string, refreshToken: string, userId?: string, email?: string): Promise<void> {
		this.logService.info('[LucosAuth] completeGoogleLogin: storing tokens and handing to daemon',
			`hasToken=${!!token}`, `hasRefreshToken=${!!refreshToken}`, `userId=${userId ?? '(none)'}`, `email=${email ?? '(none)'}`);
		try {
			// Always store tokens in OS keychain — no daemon required.
			await this.secretStorageService.set(JWT_SECRET_KEY, token);
			if (refreshToken) {
				await this.secretStorageService.set(REFRESH_TOKEN_KEY, refreshToken);
			}
			if (userId) {
				await this.secretStorageService.set(USER_ID_KEY, userId);
			}
			if (email) {
				await this.secretStorageService.set(USER_EMAIL_KEY, email);
			}
			this.logService.info('[LucosAuth] completeGoogleLogin: tokens stored in keychain');

			// Hand credentials to the daemon if it is available; failure is non-fatal
			// because the tokens are already persisted in the OS keychain.
			try {
				await this.lucosDaemonService.setCloudCredentials({ accessToken: token, userId });
				this.logService.info('[LucosAuth] completeGoogleLogin: credentials handed to daemon');
			} catch (daemonError) {
				this.logService.warn('[LucosAuth] completeGoogleLogin: daemon unavailable, credentials stored locally only',
					daemonError instanceof Error ? daemonError.message : String(daemonError));
			}

			this._setSignedIn(true, { userId, email });
			this.notificationService.notify({ severity: Severity.Info, message: localize('lucos.loginGoogle.success', "Signed in to Lucos with Google.") });
			this._cancelPendingGoogle(true);
		} catch (error) {
			this.logService.error('[LucosAuth] completeGoogleLogin: failed to store credentials', error instanceof Error ? error.message : String(error));
			this._cancelPendingGoogle(false);
			throw error;
		}
	}

	failGoogleLogin(errorDescription: string): void {
		this.logService.warn('[LucosAuth] failGoogleLogin:', errorDescription);
		this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.loginGoogle.failed', "Google sign-in failed: {0}", errorDescription) });
		this._cancelPendingGoogle(false);
	}

	async logout(): Promise<void> {
		await this.secretStorageService.delete(JWT_SECRET_KEY);
		await this.secretStorageService.delete(REFRESH_TOKEN_KEY);
		await this.secretStorageService.delete(USER_ID_KEY);
		await this.secretStorageService.delete(USER_EMAIL_KEY);
		this._setSignedIn(false);
		try {
			await this.lucosDaemonService.clearCloudCredentials();
		} catch (daemonError) {
			this.logService.warn('[LucosAuth] logout: daemon unavailable, local credentials cleared',
				daemonError instanceof Error ? daemonError.message : String(daemonError));
		}
		this.notificationService.notify({ severity: Severity.Info, message: localize('lucos.logout.done', "Signed out of Lucos.") });
	}

	async restore(): Promise<void> {
		const token = await this.secretStorageService.get(JWT_SECRET_KEY);
		if (!token) {
			return;
		}
		const userId = await this.secretStorageService.get(USER_ID_KEY);
		const email = await this.secretStorageService.get(USER_EMAIL_KEY);
		// Restore in-memory signed-in state from keychain immediately — no daemon needed.
		this._setSignedIn(true, {
			userId: userId ?? undefined,
			email: email ?? undefined,
		});
		try {
			await this.lucosDaemonService.setCloudCredentials({ accessToken: token, userId: userId ?? undefined });
		} catch {
			// Daemon may be offline at startup - the status bar reflects the disconnected state,
			// and restore is retried on next login. Swallow so startup never fails on auth.
		}
	}

	private async authenticate(email: string, password: string): Promise<{ token: string; userId?: string; orgId?: string }> {
		const gatewayUrl = ((this.configurationService.getValue<string>(LucosSettingId.CloudGatewayUrl) ?? '').trim()
			|| (this.productService.lucosGatewayUrl ?? '')).replace(/\/+$/, '');
		if (!gatewayUrl) {
			throw new Error(localize('lucos.login.noGateway', "Set `lucos.cloud.gatewayUrl` in settings first."));
		}

		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/authenticate?from=desktop`,
			headers: { 'Content-Type': 'application/json' },
			// TW-198: the gateway expects a discriminated union keyed on authType,
			// with `action` for the email flow - not a bare { email, password }.
			data: JSON.stringify({ authType: 'email', action: 'sign-in', email, password }),
			callSite: 'lucos.login',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(localize('lucos.login.badStatus', "gateway responded {0}", context.res.statusCode ?? 0));
		}

		const body = await asJson<IAuthResponse>(context);
		const token = body?.token ?? body?.accessToken;
		if (!token) {
			throw new Error(localize('lucos.login.noToken', "no token in gateway response"));
		}
		return {
			token,
			userId: body?.userId ?? body?.user?.id,
			orgId: body?.orgId ?? body?.user?.orgId,
		};
	}
}
