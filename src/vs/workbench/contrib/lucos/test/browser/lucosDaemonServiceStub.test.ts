/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LucosAuthState, LucosTaskEventKind } from '../../../../../platform/lucos/common/lucosProtocol.js';
import { LucosDaemonServiceStub } from '../../browser/lucosDaemonServiceStub.js';

suite('LucosDaemonServiceStub', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('health reports the stub as serving', async () => {
		const service = disposables.add(new LucosDaemonServiceStub());
		const health = await service.health();
		assert.strictEqual(health.serving, true);
	});

	test('setCloudCredentials authenticates and fires a change event', async () => {
		const service = disposables.add(new LucosDaemonServiceStub());
		let firedState: LucosAuthState | undefined;
		disposables.add(service.onDidChangeAuthStatus(status => { firedState = status.state; }));

		await service.setCloudCredentials({ accessToken: 'jwt', userId: 'u1' });

		assert.strictEqual(service.authStatus.state, LucosAuthState.Authenticated);
		assert.strictEqual(firedState, LucosAuthState.Authenticated);
	});

	test('startAgentTask streams start, deltas and completion', async () => {
		const service = disposables.add(new LucosDaemonServiceStub());
		const kinds: string[] = [];

		for await (const event of service.startAgentTask({ goal: 'hello', sessionId: 's1' }, CancellationToken.None)) {
			kinds.push(event.kind);
		}

		assert.strictEqual(kinds[0], LucosTaskEventKind.TaskStarted);
		assert.strictEqual(kinds[kinds.length - 1], LucosTaskEventKind.TaskCompleted);
		assert.ok(kinds.includes(LucosTaskEventKind.ModelDelta), 'expected at least one model.delta event');
	});

	test('indexWorkspace streams start, progress and completion', async () => {
		const service = disposables.add(new LucosDaemonServiceStub());
		const kinds: string[] = [];

		for await (const event of service.indexWorkspace({ workspaceRoot: '/repo' }, CancellationToken.None)) {
			kinds.push(event.kind);
		}

		assert.strictEqual(kinds[0], LucosTaskEventKind.IndexStarted);
		assert.strictEqual(kinds[kinds.length - 1], LucosTaskEventKind.IndexCompleted);
		assert.ok(kinds.includes(LucosTaskEventKind.IndexProgress), 'expected at least one index.progress event');
	});
});
