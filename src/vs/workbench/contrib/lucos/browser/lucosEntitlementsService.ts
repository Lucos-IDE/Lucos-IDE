/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { asJson, IRequestService, isSuccess } from '../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosEntitlements, ILucosEntitlementsService } from '../common/lucosEntitlementsService.js';

/** Keychain key for the cloud access JWT — owned by LucosAuthService. */
const JWT_SECRET_KEY = 'lucos.cloud.jwt';

/**
 * Cache window. Matches the daemon's entitlement TTL so the two agree on how stale
 * a plan may be, and keeps the picker from hitting the gateway on every keystroke.
 */
export const ENTITLEMENTS_CACHE_MS = 60 * 1000;

/**
 * Floor between focus-triggered refreshes. Alt-tabbing between the editor and a browser
 * is constant; without this the gateway would see a request per switch.
 */
export const FOCUS_REFRESH_MIN_INTERVAL_MS = 10 * 1000;

/**
 * Reads the seat's plan, credit balance and degrade state from api.lucos.com.
 *
 * TW-252. Everything here is advisory: the gateway enforces the real gates. If a fetch
 * fails we keep the last known value and let the request through, because a billing
 * lookup blip must never take the editor down.
 */
export class LucosEntitlementsService extends Disposable implements ILucosEntitlementsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEntitlements = this._register(new Emitter<ILucosEntitlements | undefined>());
	readonly onDidChangeEntitlements: Event<ILucosEntitlements | undefined> = this._onDidChangeEntitlements.event;

	private _current: ILucosEntitlements | undefined;
	private _fetchedAt = 0;
	/** De-duplicates concurrent callers so a burst produces one request. */
	private _inFlight: Promise<ILucosEntitlements | undefined> | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@ILucosAuthService private readonly authService: ILucosAuthService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();

		// Signing out clears the plan; signing in fetches the new one.
		this._register(this.authService.onDidChangeSignInState(signedIn => {
			if (!signedIn) {
				this.reset();
			} else {
				void this.refresh();
			}
		}));

		// Upgrades happen in the browser on lucos.com, so returning focus to the editor
		// is the moment the plan is most likely to have changed (TW-266). Refreshing
		// here means the new plan is live immediately instead of after the cache
		// expires. Rate-limited so alt-tabbing does not hammer the gateway.
		this._register(this.hostService.onDidChangeFocus(focused => {
			if (focused && Date.now() - this._fetchedAt >= FOCUS_REFRESH_MIN_INTERVAL_MS) {
				void this.refresh();
			}
		}));
	}

	get current(): ILucosEntitlements | undefined {
		return this._current;
	}

	private gatewayUrl(): string {
		return (this.configurationService.getValue<string>(LucosSettingId.CloudGatewayUrl) ?? '')
			.trim()
			.replace(/\/+$/, '');
	}

	private reset(): void {
		const had = this._current !== undefined;
		this._current = undefined;
		this._fetchedAt = 0;
		if (had) {
			this._onDidChangeEntitlements.fire(undefined);
		}
	}

	async get(): Promise<ILucosEntitlements | undefined> {
		if (this._current && Date.now() - this._fetchedAt < ENTITLEMENTS_CACHE_MS) {
			return this._current;
		}
		return this.refresh();
	}

	async refresh(): Promise<ILucosEntitlements | undefined> {
		if (this._inFlight) {
			return this._inFlight;
		}

		this._inFlight = this.doFetch().finally(() => {
			this._inFlight = undefined;
		});
		return this._inFlight;
	}

	private async doFetch(): Promise<ILucosEntitlements | undefined> {
		const gatewayUrl = this.gatewayUrl();
		if (!gatewayUrl) {
			return this._current;
		}

		const token = await this.secretStorageService.get(JWT_SECRET_KEY);
		if (!token) {
			this.reset();
			return undefined;
		}

		try {
			const context = await this.requestService.request({
				type: 'GET',
				url: `${gatewayUrl}/api/v1/entitlements`,
				headers: { Authorization: `Bearer ${token}` },
				callSite: 'lucos.entitlements',
			}, CancellationToken.None);

			if (!isSuccess(context)) {
				// Keep the previous value: a 500 is not evidence the plan changed.
				this.logService.warn('[LucosEntitlements] fetch failed', `status=${context.res.statusCode}`);
				return this._current;
			}

			const body = await asJson<ILucosEntitlements & { success?: boolean }>(context);
			if (!body?.planCode) {
				this.logService.warn('[LucosEntitlements] unexpected payload shape');
				return this._current;
			}

			const changed = this.hasChanged(this._current, body);
			this._current = body;
			this._fetchedAt = Date.now();

			if (changed) {
				this.logService.info(
					'[LucosEntitlements] updated',
					`plan=${body.planCode} remaining=$${body.credits?.remainingUsd} degrade=${body.degrade?.mode}`,
				);
				this._onDidChangeEntitlements.fire(body);
			}
			return body;
		} catch (err) {
			this.logService.warn('[LucosEntitlements] fetch error', String(err));
			return this._current;
		}
	}

	/** Only the fields the UI reacts to — avoids firing on every credit cent. */
	private hasChanged(a: ILucosEntitlements | undefined, b: ILucosEntitlements): boolean {
		if (!a) {
			return true;
		}
		return a.planCode !== b.planCode
			|| a.subscriptionStatus !== b.subscriptionStatus
			|| a.degrade?.mode !== b.degrade?.mode
			|| a.credits?.remainingUsd !== b.credits?.remainingUsd;
	}

	isModelAllowed(modelId: string): boolean {
		const allowed = this._current?.models?.allowed;
		// No entitlements yet, or an empty allowlist, means "no opinion" — show
		// everything rather than hiding models because a request failed.
		if (!allowed || allowed.length === 0) {
			return true;
		}
		return allowed.includes(modelId);
	}
}
