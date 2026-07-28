/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeLineDiff } from '../../common/lucosDiff.js';

suite('computeLineDiff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('new file is all additions', () => {
		const diff = computeLineDiff('', 'a\nb\nc');
		assert.strictEqual(diff.isNew, true);
		assert.strictEqual(diff.isDeleted, false);
		assert.strictEqual(diff.additions, 3);
		assert.strictEqual(diff.deletions, 0);
		assert.ok(diff.rows.every(r => r.type === 'add'));
	});

	test('deleted file is all deletions', () => {
		const diff = computeLineDiff('a\nb', '');
		assert.strictEqual(diff.isDeleted, true);
		assert.strictEqual(diff.additions, 0);
		assert.strictEqual(diff.deletions, 2);
		assert.ok(diff.rows.every(r => r.type === 'del'));
	});

	test('single line change reports one add and one del', () => {
		const diff = computeLineDiff('one\ntwo\nthree', 'one\nTWO\nthree');
		assert.strictEqual(diff.additions, 1);
		assert.strictEqual(diff.deletions, 1);
		const del = diff.rows.find(r => r.type === 'del');
		const add = diff.rows.find(r => r.type === 'add');
		assert.strictEqual(del?.text, 'two');
		assert.strictEqual(del?.oldLine, 2);
		assert.strictEqual(add?.text, 'TWO');
		assert.strictEqual(add?.newLine, 2);
	});

	test('identical text yields no changes', () => {
		const diff = computeLineDiff('same\ntext', 'same\ntext');
		assert.strictEqual(diff.additions, 0);
		assert.strictEqual(diff.deletions, 0);
	});

	test('gutter line numbers advance on context rows', () => {
		const diff = computeLineDiff('a\nb\nc', 'a\nb\nc\nd', { contextLines: 10 });
		const context = diff.rows.filter(r => r.type === 'context');
		assert.deepStrictEqual(context.map(r => r.oldLine), [1, 2, 3]);
		const add = diff.rows.find(r => r.type === 'add');
		assert.strictEqual(add?.newLine, 4);
	});

	test('large unchanged runs collapse into a gap row', () => {
		const original = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
		const modified = original + '\nappended';
		const diff = computeLineDiff(original, modified, { contextLines: 3 });
		const gaps = diff.rows.filter(r => r.type === 'gap');
		assert.strictEqual(gaps.length, 1);
		assert.ok((gaps[0].hiddenCount ?? 0) > 0);
		// Only the trailing context (near the change) should remain, plus the add.
		assert.strictEqual(diff.rows.filter(r => r.type === 'context').length, 3);
		assert.strictEqual(diff.additions, 1);
	});

	test('trailing newline does not create a phantom line', () => {
		const diff = computeLineDiff('a\nb\n', 'a\nb\n');
		assert.strictEqual(diff.additions, 0);
		assert.strictEqual(diff.deletions, 0);
	});
});
