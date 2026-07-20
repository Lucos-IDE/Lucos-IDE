/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveEmptyAssistantFallback } from '../../common/lucosAssistantSummary.js';

suite('resolveEmptyAssistantFallback', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('generic completion alone yields noWrittenAnswer', () => {
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({ completionSummary: 'Task completed.' }),
			{ kind: 'noWrittenAnswer' },
		);
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({ completionSummary: 'Task complete' }),
			{ kind: 'noWrittenAnswer' },
		);
	});

	test('goal-echo completion yields noWrittenAnswer', () => {
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({
				completionSummary: 'What is the tech stack?',
				goal: 'What is the tech stack?',
			}),
			{ kind: 'noWrittenAnswer' },
		);
	});

	test('meaningful completion summary yields text', () => {
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({ completionSummary: 'Stack is Go + TypeScript.' }),
			{ kind: 'text', text: 'Stack is Go + TypeScript.' },
		);
	});

	test('pending patch with empty summary yields patchReview', () => {
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({
				completionSummary: 'Task completed.',
				pendingPatch: { summary: '' },
			}),
			{ kind: 'patchReview' },
		);
	});

	test('pending patch with summary prefers patch summary', () => {
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({
				completionSummary: 'Task completed.',
				pendingPatch: { summary: 'Add status endpoint' },
			}),
			{ kind: 'text', text: 'Add status endpoint' },
		);
	});

	test('pending patch with files and empty summary lists files', () => {
		assert.deepStrictEqual(
			resolveEmptyAssistantFallback({
				pendingPatch: {
					summary: '',
					fileChanges: [{ path: 'app/api/routes/status.py' }, { path: 'app/api/router.py' }],
				},
			}),
			{ kind: 'text', text: 'Proposed changes to app/api/routes/status.py, app/api/router.py' },
		);
	});
});
