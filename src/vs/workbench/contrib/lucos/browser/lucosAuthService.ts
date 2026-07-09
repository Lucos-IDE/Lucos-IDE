/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — auth service implementation (TW-198).
 *--------------------------------------------------------------------------------------------*/

import { Action } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { asJson, IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

/** Keychain key for the cloud JWT. */
const JWT_SECRET_KEY = 'lucos.cloud.jwt';

interface IAuthResponse {
	readonly token?: string;
	readonly accessToken?: string;
	readonly userId?: string;
	readonly orgId?: string;
	readonly user?: { readonly id?: string; readonly orgId?: string };
}

export class LucosAuthService extends Disposable implements ILucosAuthService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();
	}

	async login(): Promise<boolean> {
		const email = await this.quickInputService.input({
			prompt: localize('lucos.login.email', "Lucos — email"),
			placeHolder: 'you@example.com',
			ignoreFocusLost: true,
			validateInput: async value => value.includes('@') ? undefined : localize('lucos.login.emailInvalid', "Enter a valid email address."),
		});
		if (!email) {
			return false;
		}

		const password = await this.quickInputService.input({
			prompt: localize('lucos.login.password', "Lucos — password"),
			password: true,
			ignoreFocusLost: true,
		});
		if (!password) {
			return false;
		}

		try {
			const auth = await this.authenticate(email, password);
			await this.secretStorageService.set(JWT_SECRET_KEY, auth.token);
			await this.lucosDaemonService.setCloudCredentials({
				accessToken: auth.token,
				userId: auth.userId,
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

	async logout(): Promise<void> {
		await this.secretStorageService.delete(JWT_SECRET_KEY);
		await this.lucosDaemonService.clearCloudCredentials();
		this.notificationService.notify({ severity: Severity.Info, message: localize('lucos.logout.done', "Signed out of Lucos.") });
	}

	async restore(): Promise<void> {
		const token = await this.secretStorageService.get(JWT_SECRET_KEY);
		if (!token) {
			return;
		}
		try {
			await this.lucosDaemonService.setCloudCredentials({ accessToken: token });
		} catch {
			// Daemon may be offline at startup — the status bar reflects the disconnected state,
			// and restore is retried on next login. Swallow so startup never fails on auth.
		}
	}

	private async authenticate(email: string, password: string): Promise<{ token: string; userId?: string; orgId?: string }> {
		const gatewayUrl = (this.configurationService.getValue<string>(LucosSettingId.CloudGatewayUrl) ?? '').replace(/\/+$/, '');
		if (!gatewayUrl) {
			throw new Error(localize('lucos.login.noGateway', "Set `lucos.cloud.gatewayUrl` in settings first."));
		}

		const context = await this.requestService.request({
			type: 'POST',
			url: `${gatewayUrl}/api/v1/auth/authenticate`,
			headers: { 'Content-Type': 'application/json' },
			// TW-198: the gateway expects a discriminated union keyed on authType,
			// with `action` for the email flow — not a bare { email, password }.
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
