/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { LucosMessageRole } from '../../common/lucosConversation.js';
import { MAX_HISTORY_CHARS, MAX_HISTORY_MESSAGES, windowChatHistory } from '../../common/lucosChatHistory.js';

suite('windowChatHistory', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('filters streaming and empty/whitespace-only messages', () => {
		const result = windowChatHistory([
			{ role: LucosMessageRole.User, content: 'keep me' },
			{ role: LucosMessageRole.Assistant, content: '', streaming: false },
			{ role: LucosMessageRole.Assistant, content: '   ', streaming: false },
			{ role: LucosMessageRole.Assistant, content: 'streaming', streaming: true },
			{ role: LucosMessageRole.Assistant, content: 'also keep' },
		]);

		assert.deepStrictEqual(result, [
			{ role: LucosMessageRole.User, content: 'keep me' },
			{ role: LucosMessageRole.Assistant, content: 'also keep' },
		]);
	});

	test('keeps only the most recent MAX_HISTORY_MESSAGES', () => {
		const messages = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
			role: i % 2 === 0 ? LucosMessageRole.User : LucosMessageRole.Assistant,
			content: `m${i}`,
		}));

		const result = windowChatHistory(messages);

		assert.strictEqual(result.length, MAX_HISTORY_MESSAGES);
		assert.strictEqual(result[0].content, `m${5}`);
		assert.strictEqual(result[result.length - 1].content, `m${MAX_HISTORY_MESSAGES + 4}`);
	});

	test('drops oldest messages until total content fits char budget', () => {
		const half = Math.floor(MAX_HISTORY_CHARS / 2);
		const messages = [
			{ role: LucosMessageRole.User, content: 'x'.repeat(half + 100) },
			{ role: LucosMessageRole.Assistant, content: 'y'.repeat(half + 100) },
			{ role: LucosMessageRole.User, content: 'recent' },
		];

		const result = windowChatHistory(messages);

		assert.ok(result.every(m => m.content === 'recent' || m.content.startsWith('y')));
		assert.strictEqual(result[result.length - 1].content, 'recent');
		const totalChars = result.reduce((sum, m) => sum + m.content.length, 0);
		assert.ok(totalChars <= MAX_HISTORY_CHARS);
		assert.ok(!result.some(m => m.content.startsWith('x')), 'oldest oversized turn should be dropped');
	});

	test('returns chronological oldest-first order among kept window', () => {
		const result = windowChatHistory([
			{ role: LucosMessageRole.User, content: 'first' },
			{ role: LucosMessageRole.Assistant, content: 'second' },
			{ role: LucosMessageRole.User, content: 'third' },
		]);

		assert.deepStrictEqual(result.map(m => m.content), ['first', 'second', 'third']);
	});
});
