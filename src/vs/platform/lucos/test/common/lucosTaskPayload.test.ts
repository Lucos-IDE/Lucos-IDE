/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parsePermissionRequest, taskPayloadString } from '../../common/lucosTaskPayload.js';

suite('Lucos task payload helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('taskPayloadString prefers camelCase then snake_case', () => {
		assert.strictEqual(taskPayloadString({ toolCallId: 'a', tool_call_id: 'b' }, 'toolCallId', 'tool_call_id'), 'a');
		assert.strictEqual(taskPayloadString({ tool_call_id: 'b' }, 'toolCallId', 'tool_call_id'), 'b');
		assert.strictEqual(taskPayloadString({}, 'toolCallId', 'tool_call_id'), undefined);
	});

	test('parsePermissionRequest maps snake_case daemon payload', () => {
		const request = parsePermissionRequest('task-1', {
			tool_call_id: 'tc-9',
			tool_name: 'run_command',
			command: 'npm test',
			cwd: 'packages/app',
			reason: 'Run unit tests',
		});
		assert.deepStrictEqual(request, {
			taskId: 'task-1',
			toolCallId: 'tc-9',
			toolName: 'run_command',
			command: 'npm test',
			cwd: 'packages/app',
			reason: 'Run unit tests',
		});
	});

	test('parsePermissionRequest accepts command_or_path fallback', () => {
		const request = parsePermissionRequest('task-2', {
			tool_call_id: 'tc-1',
			command_or_path: 'ls -la',
		});
		assert.ok(request);
		assert.strictEqual(request.toolName, 'run_command');
		assert.strictEqual(request.command, 'ls -la');
	});

	test('parsePermissionRequest returns undefined without tool_call_id', () => {
		assert.strictEqual(parsePermissionRequest('task-3', { tool_name: 'run_command' }), undefined);
	});
});
