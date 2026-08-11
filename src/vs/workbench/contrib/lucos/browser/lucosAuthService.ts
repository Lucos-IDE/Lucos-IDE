/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { asJson, asText, IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { LucosAuthState, LucosConnectionState } from '../../../../platform/lucos/common/lucosProtocol.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosAuthService, ILucosPendingVerification, ILucosSignedInUser } from '../common/lucosAuthService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

/** Keychain key for the cloud access JWT. */
const JWT_SECRET_KEY = 'lucos.cloud.jwt';
/** Keychain key for the opaque refresh token returned by the gateway. */
const REFRESH_TOKEN_KEY = 'lucos.cloud.refreshToken';
/** Keychain key for the signed-in user's ID. */
const USER_ID_KEY = 'lucos.cloud.userId';
/** Keychain key for the signed-in user's email address. */
const USER_EMAIL_KEY = 'lucos.cloud.email';

/** Proactive refresh window: refresh ~5 minutes before JWT `exp`. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** How often to re-check daemon auth while signed in (daemon JWT is memory-only). */
const DAEMON_AUTH_POLL_MS = 60 * 1000;

interface IAuthResponse {
	readonly success?: boolean;
	readonly token?: string;
	readonly accessToken?: string;
	readonly refreshToken?: string;
	readonly userId?: string;
	readonly orgId?: string;
	readonly user?: { readonly id?: string; readonly orgId?: string; readonly email?: string };
	readonly pendingVerification?: boolean;
	readonly email?: string;
	readonly message?: string;
}

interface IIdeStartResponse {
	readonly success: boolean;
	readonly redirectUrl?: string;
}

/** Reads JWT `exp` (seconds) as epoch milliseconds. Unverified — daemon validates via /auth/me. */
function readJwtExpiryMs(token: string): number | undefined {
	try {
		const parts = token.split('.');
		if (parts.length < 2 || !parts[1]) {
			return undefined;
		}
		const json = decodeBase64(parts[1]).toString();
		const payload = JSON.parse(json) as { exp?: unknown };
		return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/** Milliseconds until proactive refresh should fire; 0 means refresh now. */
export function msUntilRefresh(expMs: number, nowMs: number, skewMs: number = REFRESH_SKEW_MS): number {
	return Math.max(0, expMs - skewMs - nowMs);
}

export class LucosAuthService extends Disposable implements ILucosAuthService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSignInState = this._register(new Emitter<boolean>());
	readonly onDidChangeSignInState: Event<boolean> = this._onDidChangeSignInState.event;

	private _isSignedIn = false;
	get isSignedIn(): boolean { return this._isSignedIn; }

	private _signedInUser: ILucosSignedInUser | undefined;
	get signedInUser(): ILucosSignedInUser | undefined { return this._signedInUser; }

	readonly restorePromise: Promise<void>;
	private _resolveRestorePromise: (() => void) | undefined;

	private _pendingGoogleResolve: ((success: boolean) => void) | undefined;
	private _pendingGoogleNotification: INotificationHandle | undefined;
	private _pendingGoogleTimeout: ReturnType<typeof setTimeout> | undefined;
	private _syncInFlight: Promise<void> | undefined;
	private _refreshInFlight: Promise<boolean> | undefined;
	private _refreshTimer: Timeout | undefined;
	private readonly _daemonAuthPoll: RunOnceScheduler;
	/** Last observed daemon auth state — used to recover only on Authenticated → lost transitions. */
	private _daemonAuthState: LucosAuthState = LucosAuthState.Unspecified;

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
		this.restorePromise = new Promise<void>(resolve => { this._resolveRestorePromise = resolve; });
		this._daemonAuthState = this.lucosDaemonService.authStatus.state;
		this._daemonAuthPoll = this._register(new RunOnceScheduler(() => {
			void this.pollDaemonAuthStatus().finally(() => {
				if (this._isSignedIn && this.lucosDaemonService.connectionState === LucosConnectionState.Connected) {
					this._daemonAuthPoll.schedule();
				}
			});
		}, DAEMON_AUTH_POLL_MS));
		this._register(toDisposable(() => {
			clearTimeout(this._refreshTimer);
			this._refreshTimer = undefined;
		}));

		// Daemon keeps cloud JWT in memory only. Re-hand keychain credentials whenever it
		// (re)connects so restart/reconnect does not leave IDE signed-in and daemon unauthenticated.
		this._register(this.lucosDaemonService.onDidChangeConnectionState(state => {
			if (state === LucosConnectionState.Connected) {
				void this.ensureFreshSession();
				if (this._isSignedIn) {
					this.startDaemonAuthPoll();
				}
			} else {
				this.stopDaemonAuthPoll();
			}
		}));

		// When the daemon wipes its in-memory JWT (401 / expiry) while the IDE is still signed
		// in, re-hand (and refresh if needed). Only react to Authenticated → lost to avoid loops
		// when SetCloudCredentials itself returns unauthenticated.
		this._register(this.lucosDaemonService.onDidChangeAuthStatus(status => {
			const prev = this._daemonAuthState;
			this._daemonAuthState = status.state;
			if (!this._isSignedIn) {
				return;
			}
			if (this.lucosDaemonService.connectionState !== LucosConnectionState.Connected) {
				return;
			}
			const lost = status.state === LucosAuthState.Unauthenticated
				|| status.state === LucosAuthState.TokenExpired;
			if (lost && prev === LucosAuthState.Authenticated) {
				this.logService.info('[LucosAuth] daemon auth lost; ensuring fresh session and re-handing credentials');
				void this.ensureFreshSession();
			}
		}));

		this._register(this.onDidChangeSignInState(signedIn => {
			if (signedIn && this.lucosDaemonService.connectionState === LucosConnectionState.Connected) {
				this.startDaemonAuthPoll();
			} else {
				this.stopDaemonAuthPoll();
			}
		}));
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
			const auth = await this.authenticate(email, password, 'sign-in');
			await this.persistSession(auth.token, {
				refreshToken: auth.refreshToken,
				userId: auth.userId,
				email,
				orgId: auth.orgId,
			});
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

	async loginWithEmail(email: string, password: string): Promise<void> {
		this.logService.info('[LucosAuth] loginWithEmail', `email=${email}`);
		const auth = await this.authenticate(email, password, 'sign-in');
		await this.persistSession(auth.token, {
			refreshToken: auth.refreshToken,
			userId: auth.userId,
			email,
			orgId: auth.orgId,
		});
	}

	async register(email: string, password: string, name?: string): Promise<ILucosPendingVerification> {
		this.logService.info('[LucosAuth] register', `email=${email}`);
		const gatewayUrl = this.gatewayUrl();
		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/authenticate?from=desktop`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({
				authType: 'email',
				action: 'sign-up',
				email,
				password,
				...(name ? { name } : {}),
			}),
			callSite: 'lucos.register',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(await this.readGatewayError(context, localize('lucos.login.badStatus', "gateway responded {0}", context.res.statusCode ?? 0)));
		}

		const body = await asJson<IAuthResponse>(context);
		// Gateway sign-up is OTP-gated: JWT is issued only after /auth/verify-email.
		if (body?.pendingVerification) {
			return {
				pendingVerification: true,
				email: body.email ?? email,
				message: body.message,
			};
		}

		// Backward-compatible: some environments may still return a token immediately.
		const token = body?.token ?? body?.accessToken;
		if (token) {
			await this.persistSession(token, {
				refreshToken: body?.refreshToken,
				userId: body?.userId ?? body?.user?.id,
				email: body?.email ?? body?.user?.email ?? email,
				orgId: body?.orgId ?? body?.user?.orgId,
			});
			// Caller treats absence of a pending step via isSignedIn; still satisfy the return type.
			return {
				pendingVerification: true,
				email,
				message: localize('lucos.register.alreadyVerified', "Account created."),
			};
		}

		throw new Error(body?.message
			?? localize('lucos.register.noPending', "Sign-up did not start email verification. Check the gateway response."));
	}

	async verifySignupEmail(email: string, otp: string): Promise<void> {
		this.logService.info('[LucosAuth] verifySignupEmail', `email=${email}`);
		const gatewayUrl = this.gatewayUrl();
		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/verify-email`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ email, otp }),
			callSite: 'lucos.verifyEmail',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(await this.readGatewayError(context, localize('lucos.verifyEmail.badStatus', "gateway responded {0}", context.res.statusCode ?? 0)));
		}

		const body = await asJson<IAuthResponse>(context);
		const token = body?.token ?? body?.accessToken;
		if (!token) {
			throw new Error(localize('lucos.login.noToken', "no token in gateway response"));
		}
		await this.persistSession(token, {
			refreshToken: body?.refreshToken,
			userId: body?.userId ?? body?.user?.id,
			email: body?.user?.email ?? email,
			orgId: body?.orgId ?? body?.user?.orgId,
		});
	}

	async resendSignupOtp(email: string): Promise<void> {
		this.logService.info('[LucosAuth] resendSignupOtp', `email=${email}`);
		const gatewayUrl = this.gatewayUrl();
		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/resend-otp`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ email }),
			callSite: 'lucos.resendOtp',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(await this.readGatewayError(context, localize('lucos.resendOtp.badStatus', "gateway responded {0}", context.res.statusCode ?? 0)));
		}
	}

	async forgotPassword(email: string): Promise<void> {
		this.logService.info('[LucosAuth] forgotPassword', `email=${email}`);
		const gatewayUrl = this.gatewayUrl();
		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/forgot-password`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ email }),
			callSite: 'lucos.forgotPassword',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(await this.readGatewayError(context, localize('lucos.forgotPassword.badStatus', "gateway responded {0}", context.res.statusCode ?? 0)));
		}
	}

	async resetPassword(email: string, otp: string, password: string): Promise<void> {
		this.logService.info('[LucosAuth] resetPassword', `email=${email}`);
		const gatewayUrl = this.gatewayUrl();
		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/reset-password`,
			headers: { 'Content-Type': 'application/json' },
			data: JSON.stringify({ email, otp, password }),
			callSite: 'lucos.resetPassword',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(await this.readGatewayError(context, localize('lucos.resetPassword.badStatus', "gateway responded {0}", context.res.statusCode ?? 0)));
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

			this._setSignedIn(true, { userId, email });
			// Hand credentials to the daemon if available; failure is non-fatal — tokens are in keychain.
			await this.handCredentialsToDaemon({ accessToken: token, userId });
			this.scheduleRefresh(token);
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
		clearTimeout(this._refreshTimer);
		this._refreshTimer = undefined;
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
		try {
			const token = await this.secretStorageService.get(JWT_SECRET_KEY);
			if (!token) {
				return;
			}
			const exp = readJwtExpiryMs(token);
			const now = Date.now();
			if (exp === undefined || exp <= now + REFRESH_SKEW_MS) {
				const ok = await this.ensureFreshSession();
				if (!ok) {
					return; // already force-signed-out
				}
			} else {
				const userId = await this.secretStorageService.get(USER_ID_KEY);
				const email = await this.secretStorageService.get(USER_EMAIL_KEY);
				this._setSignedIn(true, {
					userId: userId ?? undefined,
					email: email ?? undefined,
				});
				await this.syncCredentialsToDaemon();
				this.scheduleRefresh(token);
			}
		} finally {
			// Always resolve so anything awaiting restorePromise unblocks regardless of outcome.
			this._resolveRestorePromise?.();
			this._resolveRestorePromise = undefined;
		}
	}

	/**
	 * Refresh access JWT if expired or within {@link REFRESH_SKEW_MS} of expiry, then
	 * re-hand credentials to the daemon. Returns false if the session was cleared (hard fail).
	 */
	ensureFreshSession(): Promise<boolean> {
		if (!this._refreshInFlight) {
			this._refreshInFlight = this.doEnsureFreshSession().finally(() => {
				this._refreshInFlight = undefined;
			});
		}
		return this._refreshInFlight;
	}

	private async doEnsureFreshSession(): Promise<boolean> {
		const token = await this.secretStorageService.get(JWT_SECRET_KEY);
		if (!token) {
			if (this._isSignedIn) {
				this._setSignedIn(false);
			}
			return false;
		}
		const exp = readJwtExpiryMs(token);
		const now = Date.now();
		if (exp === undefined || exp <= now + REFRESH_SKEW_MS) {
			this.logService.info('[LucosAuth] ensureFreshSession: token expired or near expiry, refreshing');
			// refreshSession → persistSession already hands credentials to the daemon.
			return this.refreshSession();
		}
		this.scheduleRefresh(token);
		// Daemon may have lost its memory-only JWT while the IDE keychain token is still valid.
		await this.syncCredentialsToDaemon();
		return true;
	}

	/** Poll daemon auth so silent in-memory JWT revocation is visible to the IDE. */
	private startDaemonAuthPoll(): void {
		if (!this._daemonAuthPoll.isScheduled()) {
			this._daemonAuthPoll.schedule();
		}
	}

	private stopDaemonAuthPoll(): void {
		this._daemonAuthPoll.cancel();
	}

	private async pollDaemonAuthStatus(): Promise<void> {
		if (!this._isSignedIn) {
			return;
		}
		if (this.lucosDaemonService.connectionState !== LucosConnectionState.Connected) {
			return;
		}
		try {
			await this.lucosDaemonService.getAuthStatus();
		} catch (error) {
			this.logService.trace('[LucosAuth] daemon auth poll failed',
				error instanceof Error ? error.message : String(error));
		}
	}

	/** POST /api/v1/auth/refresh; on failure force-signs-out. */
	private async refreshSession(): Promise<boolean> {
		const refreshToken = await this.secretStorageService.get(REFRESH_TOKEN_KEY);
		if (!refreshToken) {
			this.logService.warn('[LucosAuth] refreshSession: no refresh token in keychain');
			await this.forceSignOut();
			return false;
		}

		try {
			const gatewayUrl = this.gatewayUrl();
			this.logService.info('[LucosAuth] refreshSession: calling gateway refresh');
			const context = await this.requestService.request({
				type: 'POST',
				url: `${gatewayUrl}/api/v1/auth/refresh`,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify({ refreshToken }),
				callSite: 'lucos.refresh',
			}, CancellationToken.None);

			if (!isSuccess(context)) {
				const message = await this.readGatewayError(context, localize('lucos.refresh.badStatus', "gateway responded {0}", context.res.statusCode ?? 0));
				this.logService.warn('[LucosAuth] refreshSession: refresh failed', message);
				await this.forceSignOut();
				return false;
			}

			const body = await asJson<IAuthResponse>(context);
			const token = body?.token ?? body?.accessToken;
			if (!token) {
				this.logService.warn('[LucosAuth] refreshSession: success response missing token');
				await this.forceSignOut();
				return false;
			}

			await this.persistSession(token, {
				refreshToken: body?.refreshToken,
				userId: body?.userId ?? body?.user?.id,
				email: body?.email ?? body?.user?.email,
				orgId: body?.orgId ?? body?.user?.orgId,
			});
			this.logService.info('[LucosAuth] refreshSession: session refreshed');
			return true;
		} catch (error) {
			this.logService.error('[LucosAuth] refreshSession: network or unexpected error',
				error instanceof Error ? error.message : String(error));
			await this.forceSignOut();
			return false;
		}
	}

	/** Clear keychain session without a success notification (refresh hard-fail path). */
	private async forceSignOut(): Promise<void> {
		this.logService.warn('[LucosAuth] forceSignOut: clearing session due to refresh failure');
		clearTimeout(this._refreshTimer);
		this._refreshTimer = undefined;
		await this.secretStorageService.delete(JWT_SECRET_KEY);
		await this.secretStorageService.delete(REFRESH_TOKEN_KEY);
		await this.secretStorageService.delete(USER_ID_KEY);
		await this.secretStorageService.delete(USER_EMAIL_KEY);
		this._setSignedIn(false);
		try {
			await this.lucosDaemonService.clearCloudCredentials();
		} catch (daemonError) {
			this.logService.warn('[LucosAuth] forceSignOut: daemon unavailable, local credentials cleared',
				daemonError instanceof Error ? daemonError.message : String(daemonError));
		}
	}

	/** Schedule proactive refresh ~5 minutes before JWT exp. */
	private scheduleRefresh(accessToken: string): void {
		clearTimeout(this._refreshTimer);
		this._refreshTimer = undefined;
		const exp = readJwtExpiryMs(accessToken);
		if (exp === undefined) {
			return;
		}
		const delay = msUntilRefresh(exp, Date.now());
		if (delay === 0) {
			void this.ensureFreshSession();
			return;
		}
		this.logService.trace('[LucosAuth] scheduleRefresh', `delayMs=${delay}`);
		this._refreshTimer = setTimeout(() => {
			void this.ensureFreshSession();
		}, delay);
	}

	/**
	 * Reads the keychain JWT and pushes it to the daemon. Used on restore and whenever the
	 * daemon (re)connects. Single-flight so overlapping Connected + restore calls share one RPC.
	 */
	private syncCredentialsToDaemon(): Promise<void> {
		if (!this._syncInFlight) {
			this._syncInFlight = this.doSyncCredentialsToDaemon().finally(() => {
				this._syncInFlight = undefined;
			});
		}
		return this._syncInFlight;
	}

	private async doSyncCredentialsToDaemon(): Promise<void> {
		const token = await this.secretStorageService.get(JWT_SECRET_KEY);
		if (!token) {
			return;
		}
		const userId = await this.secretStorageService.get(USER_ID_KEY);
		const email = await this.secretStorageService.get(USER_EMAIL_KEY);
		if (!this._isSignedIn) {
			this._setSignedIn(true, {
				userId: userId ?? undefined,
				email: email ?? undefined,
			});
		}
		await this.handCredentialsToDaemon({
			accessToken: token,
			userId: userId ?? undefined,
		});
	}

	/** SetCloudCredentials with JWT expiry; daemon-offline errors are non-fatal. */
	private async handCredentialsToDaemon(credentials: {
		accessToken: string;
		userId?: string;
		orgId?: string;
	}): Promise<void> {
		try {
			await this.lucosDaemonService.setCloudCredentials({
				accessToken: credentials.accessToken,
				userId: credentials.userId,
				orgId: credentials.orgId,
				expiresAt: readJwtExpiryMs(credentials.accessToken),
			});
			this.logService.info('[LucosAuth] credentials handed to daemon');
		} catch (daemonError) {
			this.logService.warn('[LucosAuth] daemon unavailable, credentials stored locally only',
				daemonError instanceof Error ? daemonError.message : String(daemonError));
		}
	}

	private gatewayUrl(): string {
		const gatewayUrl = ((this.configurationService.getValue<string>(LucosSettingId.CloudGatewayUrl) ?? '').trim()
			|| (this.productService.lucosGatewayUrl ?? '')).replace(/\/+$/, '');
		if (!gatewayUrl) {
			throw new Error(localize('lucos.login.noGateway', "Set `lucos.cloud.gatewayUrl` in settings first."));
		}
		return gatewayUrl;
	}

	private async readGatewayError(context: Awaited<ReturnType<IRequestService['request']>>, fallback: string): Promise<string> {
		// asJson() rejects non-2xx responses, so read the body as text for error payloads.
		try {
			const text = await asText(context);
			if (text) {
				const errBody = JSON.parse(text) as { message?: string; error?: string };
				if (errBody?.message) {
					return errBody.message;
				}
				if (errBody?.error) {
					return errBody.error;
				}
			}
		} catch { /* ignore body parse errors */ }
		return fallback;
	}

	/** Persist JWT (+ optional refresh) to keychain, update signed-in state, hand off to daemon. */
	private async persistSession(token: string, opts: {
		refreshToken?: string;
		userId?: string;
		email?: string;
		orgId?: string;
	}): Promise<void> {
		await this.secretStorageService.set(JWT_SECRET_KEY, token);
		if (opts.refreshToken) {
			await this.secretStorageService.set(REFRESH_TOKEN_KEY, opts.refreshToken);
		}
		if (opts.userId) {
			await this.secretStorageService.set(USER_ID_KEY, opts.userId);
		}
		if (opts.email) {
			await this.secretStorageService.set(USER_EMAIL_KEY, opts.email);
		}
		this._setSignedIn(true, { userId: opts.userId, email: opts.email });
		await this.handCredentialsToDaemon({
			accessToken: token,
			userId: opts.userId,
			orgId: opts.orgId,
		});
		this.scheduleRefresh(token);
	}

	private async authenticate(email: string, password: string, action: 'sign-in' | 'sign-up' = 'sign-in', extras?: Record<string, string>): Promise<{ token: string; refreshToken?: string; userId?: string; orgId?: string }> {
		const gatewayUrl = this.gatewayUrl();

		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/authenticate?from=desktop`,
			headers: { 'Content-Type': 'application/json' },
			// TW-198: the gateway expects a discriminated union keyed on authType,
			// with `action` for the email flow - not a bare { email, password }.
			data: JSON.stringify({ authType: 'email', action, email, password, ...extras }),
			callSite: 'lucos.login',
		}, CancellationToken.None);

		if (!isSuccess(context)) {
			throw new Error(await this.readGatewayError(context, localize('lucos.login.badStatus', "gateway responded {0}", context.res.statusCode ?? 0)));
		}

		const body = await asJson<IAuthResponse>(context);
		if (body?.pendingVerification) {
			throw new Error(body.message
				?? localize('lucos.login.pendingVerification', "Email verification required before sign-in."));
		}
		const token = body?.token ?? body?.accessToken;
		if (!token) {
			this.logService.warn('[LucosAuth] authenticate: success response missing token',
				`keys=${body ? Object.keys(body).join(',') : '(null)'}`);
			throw new Error(localize('lucos.login.noToken', "no token in gateway response"));
		}
		return {
			token,
			refreshToken: body?.refreshToken,
			userId: body?.userId ?? body?.user?.id,
			orgId: body?.orgId ?? body?.user?.orgId,
		};
	}
}
