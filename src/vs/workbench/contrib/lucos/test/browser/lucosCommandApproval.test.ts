/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LucosTaskEventKind } from '../../../../../platform/lucos/common/lucosProtocol.js';
import { permissionRequestFromTaskEvent } from '../../browser/lucosCommandApproval.js';

suite('LucosCommandApproval', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps permission.requested payload for the approval view', () => {
		const request = permissionRequestFromTaskEvent({
			taskId: 'task-1',
			kind: LucosTaskEventKind.PermissionRequested,
			sequence: 3,
			timestamp: 1,
			severity: 'info',
			payload: {
				tool_call_id: 'tool-call-1',
				tool_name: 'run_command',
				command: 'npm test',
				cwd: '/workspace',
				reason: 'Run the test suite',
			},
		});

		assert.deepStrictEqual(request, {
			taskId: 'task-1',
			toolCallId: 'tool-call-1',
			toolName: 'run_command',
			command: 'npm test',
			cwd: '/workspace',
			reason: 'Run the test suite',
		});
	});

	test('ignores malformed permission requests', () => {
		const request = permissionRequestFromTaskEvent({
			taskId: 'task-1',
			kind: LucosTaskEventKind.PermissionRequested,
			sequence: 3,
			timestamp: 1,
			severity: 'info',
			payload: { tool_name: 'run_command' },
		});

		assert.strictEqual(request, undefined);
	});
});
