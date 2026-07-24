/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resolveCompletionAppend, resolveEmptyAssistantFallback, sanitizeAssistantText } from '../../common/lucosAssistantSummary.js';

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

suite('resolveCompletionAppend', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('appends meaningful summary when preamble already exists', () => {
		assert.strictEqual(
			resolveCompletionAppend('Let me read the README.', {
				completionSummary: 'The stack is Go + TypeScript.',
			}),
			'The stack is Go + TypeScript.',
		);
	});

	test('skips generic completion when preamble exists', () => {
		assert.strictEqual(
			resolveCompletionAppend('Let me read the README.', {
				completionSummary: 'Task completed.',
			}),
			undefined,
		);
	});

	test('skips when summary is already contained in the bubble', () => {
		assert.strictEqual(
			resolveCompletionAppend('The stack is Go + TypeScript.', {
				completionSummary: 'The stack is Go + TypeScript.',
			}),
			undefined,
		);
	});

	test('skips when summary duplicates last sentence ignoring punctuation', () => {
		assert.strictEqual(
			resolveCompletionAppend('Here is the answer. The stack is Go + TypeScript.', {
				completionSummary: 'The stack is Go + TypeScript',
			}),
			undefined,
		);
	});

	test('skips goal-echo completion when preamble exists', () => {
		assert.strictEqual(
			resolveCompletionAppend('Looking into that.', {
				completionSummary: 'What is the tech stack?',
				goal: 'What is the tech stack?',
			}),
			undefined,
		);
	});

	test('prefers patch summary over completion summary', () => {
		assert.strictEqual(
			resolveCompletionAppend('Preparing a patch.', {
				completionSummary: 'Done.',
				pendingPatch: { summary: 'Add status endpoint' },
			}),
			'Add status endpoint',
		);
	});

	test('returns candidate when existing content is empty', () => {
		assert.strictEqual(
			resolveCompletionAppend('', {
				completionSummary: 'Stack is Go + TypeScript.',
			}),
			'Stack is Go + TypeScript.',
		);
	});
});

suite('sanitizeAssistantText', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips truncated-bytes markers', () => {
		assert.strictEqual(
			sanitizeAssistantText('Hello\n… [truncated 1200 bytes]'),
			'Hello',
		);
		assert.strictEqual(
			sanitizeAssistantText('Hello [truncated 40 bytes] world'),
			'Hello world',
		);
	});

	test('strips control bytes but keeps newlines and tabs', () => {
		assert.strictEqual(
			sanitizeAssistantText('a\u0000b\tc\nd'),
			'ab\tc\nd',
		);
	});

	test('collapses double sentence punctuation without eating ellipsis', () => {
		assert.strictEqual(sanitizeAssistantText('Done..'), 'Done.');
		assert.strictEqual(sanitizeAssistantText('Done. .'), 'Done.');
		assert.strictEqual(sanitizeAssistantText('Wait...'), 'Wait...');
	});
});
