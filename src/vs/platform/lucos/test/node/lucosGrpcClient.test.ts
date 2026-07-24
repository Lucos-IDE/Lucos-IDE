/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isLucosDaemonUnavailableError } from '../../node/lucosGrpcClient.js';

suite('isLucosDaemonUnavailableError', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('matches gRPC UNAVAILABLE code', () => {
		assert.strictEqual(isLucosDaemonUnavailableError({ code: 14, message: 'UNAVAILABLE' }), true);
		assert.strictEqual(isLucosDaemonUnavailableError({ code: 'UNAVAILABLE', message: 'x' }), true);
	});

	test('matches ECONNREFUSED message', () => {
		assert.strictEqual(isLucosDaemonUnavailableError({
			message: '14 UNAVAILABLE: No connection established. Last error: Error: connect ECONNREFUSED 127.0.0.1:54054',
		}), true);
	});

	test('rejects unrelated errors', () => {
		assert.strictEqual(isLucosDaemonUnavailableError({ code: 16, message: 'UNAUTHENTICATED' }), false);
		assert.strictEqual(isLucosDaemonUnavailableError(new Error('workspace_root is required')), false);
		assert.strictEqual(isLucosDaemonUnavailableError(undefined), false);
	});
});
