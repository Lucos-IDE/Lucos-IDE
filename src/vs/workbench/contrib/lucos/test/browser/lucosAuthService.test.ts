/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { bufferToStream, encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { LucosAuthState } from '../../../../../platform/lucos/common/lucosProtocol.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { LucosAuthService, msUntilRefresh } from '../../browser/lucosAuthService.js';
import { LucosDaemonServiceStub } from '../../browser/lucosDaemonServiceStub.js';
import { LucosSettingId } from '../../common/lucosConfiguration.js';

suite('LucosAuthService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('msUntilRefresh skew math', () => {
		assert.strictEqual(msUntilRefresh(100_000, 90_000, 5_000), 5_000);
		assert.strictEqual(msUntilRefresh(100_000, 96_000, 5_000), 0);
	});

	test('near-expiry JWT refreshes and persists rotated refresh token', async () => {
		const secrets = new TestSecretStorageService();
		disposables.add(secrets);
		const daemon = disposables.add(new LucosDaemonServiceStub());
		const requestStub = new StubRequestService();
		const nearExpJwt = makeJwt(Math.floor(Date.now() / 1000) + 60);
		const newJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);

		await secrets.set('lucos.cloud.jwt', nearExpJwt);
		await secrets.set('lucos.cloud.refreshToken', 'old-refresh');
		await secrets.set('lucos.cloud.userId', 'u1');
		await secrets.set('lucos.cloud.email', 'u1@example.com');

		requestStub.queue('POST', /\/api\/v1\/auth\/refresh$/, jsonResponse(200, {
			token: newJwt,
			refreshToken: 'new-refresh',
			userId: 'u1',
		}));

		const service = disposables.add(createAuthService(secrets, requestStub, daemon));
		const ok = await service.ensureFreshSession();

		assert.strictEqual(ok, true);
		assert.strictEqual(service.isSignedIn, true);
		assert.strictEqual(await secrets.get('lucos.cloud.jwt'), newJwt);
		assert.strictEqual(await secrets.get('lucos.cloud.refreshToken'), 'new-refresh');
		assert.strictEqual(daemon.authStatus.state, LucosAuthState.Authenticated);
		assert.strictEqual(daemon.authStatus.userId, 'u1');
		assert.strictEqual(requestStub.requests.length, 1);
		assert.ok(requestStub.requests[0].url?.includes('/api/v1/auth/refresh'));
	});

	test('refresh 401 clears session and fires signed-out', async () => {
		const secrets = new TestSecretStorageService();
		disposables.add(secrets);
		const daemon = disposables.add(new LucosDaemonServiceStub());
		const requestStub = new StubRequestService();
		const nearExpJwt = makeJwt(Math.floor(Date.now() / 1000) + 60);

		await secrets.set('lucos.cloud.jwt', nearExpJwt);
		await secrets.set('lucos.cloud.refreshToken', 'old-refresh');
		await secrets.set('lucos.cloud.userId', 'u1');
		await secrets.set('lucos.cloud.email', 'u1@example.com');

		// Establish signed-in state with a still-valid JWT, then swap to near-expiry.
		const farJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);
		await secrets.set('lucos.cloud.jwt', farJwt);
		const service = disposables.add(createAuthService(secrets, requestStub, daemon));
		await service.restore();
		assert.strictEqual(service.isSignedIn, true);

		await secrets.set('lucos.cloud.jwt', nearExpJwt);
		requestStub.queue('POST', /\/api\/v1\/auth\/refresh$/, jsonResponse(401, { message: 'invalid refresh' }));

		let signedOut: boolean | undefined;
		disposables.add(service.onDidChangeSignInState(v => { signedOut = v; }));

		const ok = await service.ensureFreshSession();

		assert.strictEqual(ok, false);
		assert.strictEqual(service.isSignedIn, false);
		assert.strictEqual(signedOut, false);
		assert.strictEqual(await secrets.get('lucos.cloud.jwt'), undefined);
		assert.strictEqual(await secrets.get('lucos.cloud.refreshToken'), undefined);
		assert.strictEqual(daemon.authStatus.state, LucosAuthState.Unauthenticated);
	});

	test('concurrent ensureFreshSession shares one refresh request', async () => {
		const secrets = new TestSecretStorageService();
		disposables.add(secrets);
		const daemon = disposables.add(new LucosDaemonServiceStub());
		const requestStub = new StubRequestService();
		const nearExpJwt = makeJwt(Math.floor(Date.now() / 1000) + 60);
		const newJwt = makeJwt(Math.floor(Date.now() / 1000) + 3600);

		await secrets.set('lucos.cloud.jwt', nearExpJwt);
		await secrets.set('lucos.cloud.refreshToken', 'old-refresh');
		await secrets.set('lucos.cloud.userId', 'u1');

		let resolveRefresh!: (ctx: IRequestContext) => void;
		const delayed = new Promise<IRequestContext>(resolve => { resolveRefresh = resolve; });
		requestStub.queueAsync('POST', /\/api\/v1\/auth\/refresh$/, () => delayed);

		const service = disposables.add(createAuthService(secrets, requestStub, daemon));
		const p1 = service.ensureFreshSession();
		const p2 = service.ensureFreshSession();

		// Allow both callers to enter the single-flight before resolving the HTTP response.
		await timeout(10);
		assert.strictEqual(requestStub.requests.length, 1);

		resolveRefresh(jsonResponse(200, {
			token: newJwt,
			refreshToken: 'new-refresh',
			userId: 'u1',
		})());

		const [ok1, ok2] = await Promise.all([p1, p2]);
		assert.strictEqual(ok1, true);
		assert.strictEqual(ok2, true);
		assert.strictEqual(requestStub.requests.length, 1);
		assert.strictEqual(await secrets.get('lucos.cloud.refreshToken'), 'new-refresh');
	});
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function b64(obj: unknown): string {
	return encodeBase64(VSBuffer.fromString(JSON.stringify(obj)));
}

function makeJwt(expSec: number): string {
	return `${b64({ alg: 'none' })}.${b64({ exp: expSec })}.x`;
}

function createAuthService(
	secrets: ISecretStorageService,
	requestStub: StubRequestService,
	daemon: LucosDaemonServiceStub,
): LucosAuthService {
	return new LucosAuthService(
		{} as IQuickInputService,
		requestStub as unknown as IRequestService,
		secrets,
		new TestNotificationService(),
		{
			getValue: (key: string) => key === LucosSettingId.CloudGatewayUrl ? 'https://gateway.test' : undefined,
		} as unknown as IConfigurationService,
		daemon,
		{} as IOpenerService,
		{ lucosGatewayUrl: 'https://gateway.test', urlProtocol: 'lucos' } as unknown as IProductService,
		new NullLogService(),
	);
}

interface QueuedResponse {
	readonly methodMatcher: string;
	readonly urlMatcher: RegExp;
	readonly response: () => Promise<IRequestContext> | IRequestContext;
}

class StubRequestService implements Partial<IRequestService> {
	declare readonly _serviceBrand: undefined;

	private readonly _queue: QueuedResponse[] = [];
	readonly requests: IRequestOptions[] = [];

	queue(method: string, urlMatcher: RegExp, response: () => IRequestContext): void {
		this._queue.push({ methodMatcher: method, urlMatcher, response });
	}

	queueAsync(method: string, urlMatcher: RegExp, response: () => Promise<IRequestContext>): void {
		this._queue.push({ methodMatcher: method, urlMatcher, response });
	}

	async request(options: IRequestOptions, _token: CancellationToken): Promise<IRequestContext> {
		this.requests.push(options);
		const url = options.url ?? '';
		const method = options.type ?? 'GET';
		const idx = this._queue.findIndex(q => q.methodMatcher === method && q.urlMatcher.test(url));
		if (idx === -1) {
			throw new Error(`No queued response for ${method} ${url}`);
		}
		const [{ response }] = this._queue.splice(idx, 1);
		return response();
	}
}

function jsonResponse(statusCode: number, body: unknown): () => IRequestContext {
	return () => ({
		res: { statusCode, headers: {} },
		stream: bufferToStream(VSBuffer.fromString(JSON.stringify(body))),
	});
}

function timeout(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
