/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IURLHandler, IURLService } from '../../../../platform/url/common/url.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';

/**
 * Handles `lucos://auth/callback` deep links produced by the gateway after completing
 * Google OAuth. The gateway redirects here with either:
 *   success: ?success=true&token=<JWT>&refreshToken=<REFRESH>&userId=<ID>&email=<EMAIL>&isNewUser=true|false
 *   failure: ?error=<code>&error_description=<detail>
 */
export class LucosAuthCallbackHandler extends Disposable implements IWorkbenchContribution, IURLHandler {
	static readonly ID = 'workbench.contrib.lucosAuthCallback';

	constructor(
		@IURLService urlService: IURLService,
		@ILucosAuthService private readonly lucosAuthService: ILucosAuthService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.logService.trace('[LucosAuth] LucosAuthCallbackHandler registered for lucos://auth/callback');
		this._register(urlService.registerHandler(this));
	}

	async handleURL(uri: URI): Promise<boolean> {
		this.logService.trace('[LucosAuth] handleURL called', uri.toString(/* skipEncoding */ true));

		if (uri.authority !== 'auth' || uri.path !== '/callback') {
			this.logService.trace('[LucosAuth] handleURL: ignoring — authority or path does not match', `authority=${uri.authority}`, `path=${uri.path}`);
			return false;
		}

		const params = new URLSearchParams(uri.query);

		// Error path: gateway or Google denied the request.
		const error = params.get('error');
		if (error) {
			const description = params.get('error_description') ?? error;
			this.logService.warn('[LucosAuth] handleURL: received error from gateway', `error=${error}`, `description=${description}`);
			this.lucosAuthService.failGoogleLogin(decodeURIComponent(description));
			return true;
		}

		// Success path: gateway issued Lucos JWTs and redirected here.
		if (params.get('success') !== 'true') {
			this.logService.warn('[LucosAuth] handleURL: missing success=true, ignoring callback', `query=${uri.query}`);
			return false;
		}

		const token = params.get('token');
		const refreshToken = params.get('refreshToken') ?? '';
		const userId = params.get('userId') ?? '(none)';
		const email = params.get('email') ?? '(none)';
		const isNewUser = params.get('isNewUser');

		this.logService.info('[LucosAuth] handleURL: success callback received', `userId=${userId}`, `email=${email}`, `isNewUser=${isNewUser}`, `hasToken=${!!token}`, `hasRefreshToken=${!!refreshToken}`);

		if (!token) {
			this.logService.error('[LucosAuth] handleURL: success=true but no token in query params');
			this.lucosAuthService.failGoogleLogin('No token received from gateway.');
			return true;
		}

		const resolvedUserId = userId !== '(none)' ? userId : undefined;
		const resolvedEmail = email !== '(none)' ? email : undefined;
		await this.lucosAuthService.completeGoogleLogin(token, refreshToken, resolvedUserId, resolvedEmail);
		this.logService.info('[LucosAuth] handleURL: completeGoogleLogin finished');
		return true;
	}
}
