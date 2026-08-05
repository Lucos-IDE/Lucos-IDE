/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IRequestContext, IRequestOptions } from '../../../../../base/parts/request/common/request.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IRequestService } from '../../../../../platform/request/common/request.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ILucosAuthService } from '../../common/lucosAuthService.js';
import { LucosSettingId } from '../../common/lucosConfiguration.js';
import { LucosEntitlementsService } from '../../browser/lucosEntitlementsService.js';

suite('LucosEntitlementsService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const proPayload = {
		success: true,
		seatId: 'seat-1',
		planCode: 'pro',
		planName: 'Pro',
		subscriptionStatus: 'active',
		credits: { includedUsd: 20, bonusUsd: 0, spentUsd: 4.72, remainingUsd: 15.28, percentUsed: 23.6 },
		period: { start: '2026-08-01T00:00:00.000Z', end: '2026-08-31T00:00:00.000Z' },
		degrade: { mode: 'none', agentToolsEnabled: true, forcedModel: null },
		models: { allowed: ['claude-haiku-4-5', 'claude-sonnet-4-6'], default: 'claude-sonnet-4-6', degrade: 'claude-haiku-4-5' },
		limits: { maxIndexedRepos: null, indexedRepoCount: 12 },
		links: { upgrade: 'https://lucos.com/manage-plan', billing: 'https://lucos.com/billing' },
	};

	const freePayload = {
		...proPayload,
		planCode: 'free',
		planName: 'Free',
		credits: { includedUsd: 2, bonusUsd: 0, spentUsd: 2, remainingUsd: 0, percentUsed: 100 },
		degrade: { mode: 'degraded', agentToolsEnabled: false, forcedModel: 'claude-haiku-4-5' },
		models: { allowed: ['claude-haiku-4-5'], default: 'claude-haiku-4-5', degrade: 'claude-haiku-4-5' },
		limits: { maxIndexedRepos: 30, indexedRepoCount: 4 },
	};

	test('fetches and exposes the seat plan', async () => {
		const { service, requests } = await createService(proPayload);

		const result = await service.get();
		assert.strictEqual(result?.planCode, 'pro');
		assert.strictEqual(result?.credits.remainingUsd, 15.28);
		assert.strictEqual(requests.length, 1);
		assert.ok(requests[0].url?.includes('/api/v1/entitlements'));
		assert.strictEqual(requests[0].headers?.['Authorization'], 'Bearer test-jwt');
	});

	test('second read inside the cache window does not refetch', async () => {
		const { service, requests } = await createService(proPayload);

		await service.get();
		await service.get();
		assert.strictEqual(requests.length, 1);
	});

	test('refresh() bypasses the cache', async () => {
		const { service, requests, stub } = await createService(proPayload);

		await service.get();
		stub.queue('GET', /\/api\/v1\/entitlements$/, jsonResponse(200, proPayload));
		await service.refresh();
		assert.strictEqual(requests.length, 2);
	});

	test('concurrent callers share one request', async () => {
		const { service, requests } = await createService(proPayload);

		await Promise.all([service.get(), service.get(), service.get()]);
		assert.strictEqual(requests.length, 1);
	});

	test('a failed fetch keeps the previous value rather than clearing the plan', async () => {
		const { service, stub } = await createService(proPayload);

		await service.get();
		stub.queue('GET', /\/api\/v1\/entitlements$/, jsonResponse(500, { error: 'boom' }));
		const result = await service.refresh();

		// A gateway blip must not make a paying user look like they are on Free.
		assert.strictEqual(result?.planCode, 'pro');
		assert.strictEqual(service.current?.planCode, 'pro');
	});

	test('isModelAllowed reflects the plan allowlist', async () => {
		const { service } = await createService(freePayload);
		await service.get();

		assert.strictEqual(service.isModelAllowed('claude-haiku-4-5'), true);
		assert.strictEqual(service.isModelAllowed('claude-sonnet-4-6'), false);
	});

	test('isModelAllowed permits everything before entitlements load', async () => {
		const { service } = await createService(proPayload);

		// Never hide models just because the request has not completed.
		assert.strictEqual(service.isModelAllowed('anything-at-all'), true);
	});

	test('degraded seat reports tools off and a forced model', async () => {
		const { service } = await createService(freePayload);
		const result = await service.get();

		assert.strictEqual(result?.degrade.mode, 'degraded');
		assert.strictEqual(result?.degrade.agentToolsEnabled, false);
		assert.strictEqual(result?.degrade.forcedModel, 'claude-haiku-4-5');
	});

	test('fires a change event when the plan changes', async () => {
		const { service, stub } = await createService(proPayload);

		let fired = 0;
		disposables.add(service.onDidChangeEntitlements(() => { fired++; }));

		await service.get();
		assert.strictEqual(fired, 1, 'first load fires');

		stub.queue('GET', /\/api\/v1\/entitlements$/, jsonResponse(200, proPayload));
		await service.refresh();
		assert.strictEqual(fired, 1, 'identical payload does not re-fire');

		stub.queue('GET', /\/api\/v1\/entitlements$/, jsonResponse(200, freePayload));
		await service.refresh();
		assert.strictEqual(fired, 2, 'plan change fires');
	});

	test('regaining window focus refreshes after an upgrade in the browser', async () => {
		const { service, stub, requests, focusEmitter } = await createService(proPayload);

		// Nothing fetched yet, so focus should trigger the first read.
		stub.queue('GET', /\/api\/v1\/entitlements$/, jsonResponse(200, freePayload));
		focusEmitter.fire(true);
		await waitFor(() => requests.length === 1);

		assert.strictEqual(service.current?.planCode, 'free');
	});

	test('losing focus does not refresh', async () => {
		const { requests, focusEmitter } = await createService(proPayload);

		focusEmitter.fire(false);
		await timeout(10);
		assert.strictEqual(requests.length, 0);
	});

	test('rapid focus changes are rate limited', async () => {
		const { service, requests, focusEmitter } = await createService(proPayload);

		await service.get();
		assert.strictEqual(requests.length, 1);

		// Alt-tabbing repeatedly must not produce a request per switch.
		focusEmitter.fire(true);
		focusEmitter.fire(true);
		focusEmitter.fire(true);
		await timeout(10);
		assert.strictEqual(requests.length, 1);
	});

	test('no stored token yields no entitlements and no request', async () => {
		const { service, requests } = await createService(proPayload, { token: undefined });

		const result = await service.get();
		assert.strictEqual(result, undefined);
		assert.strictEqual(requests.length, 0);
	});

	// ---- helpers ----

	async function createService(
		payload: unknown,
		options: { token?: string } = { token: 'test-jwt' },
	) {
		const secrets = new TestSecretStorageService();
		disposables.add(secrets);
		if (options.token) {
			await secrets.set('lucos.cloud.jwt', options.token);
		}

		const stub = new StubRequestService();
		stub.queue('GET', /\/api\/v1\/entitlements$/, jsonResponse(200, payload));

		const configurationService = {
			getValue: (key: string) => key === LucosSettingId.CloudGatewayUrl ? 'https://api.lucos.com' : undefined,
		} as unknown as IConfigurationService;

		const signInEmitter = disposables.add(new Emitter<boolean>());
		const authService = {
			onDidChangeSignInState: signInEmitter.event,
		} as unknown as ILucosAuthService;

		const focusEmitter = disposables.add(new Emitter<boolean>());
		const hostService = {
			onDidChangeFocus: focusEmitter.event,
		} as unknown as IHostService;

		const service = disposables.add(new LucosEntitlementsService(
			stub as unknown as IRequestService,
			secrets as unknown as ISecretStorageService,
			configurationService,
			new NullLogService(),
			authService,
			hostService,
		));

		return { service, stub, requests: stub.requests, signInEmitter, focusEmitter };
	}
});

interface QueuedResponse {
	methodMatcher: string;
	urlMatcher: RegExp;
	response: () => IRequestContext;
}

class StubRequestService implements Partial<IRequestService> {
	declare readonly _serviceBrand: undefined;

	private readonly _queue: QueuedResponse[] = [];
	readonly requests: IRequestOptions[] = [];

	queue(method: string, urlMatcher: RegExp, response: () => IRequestContext): void {
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

/** Polls until `predicate` holds, so tests do not depend on a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('waitFor timed out');
		}
		await timeout(5);
	}
}
