/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeLineChangeStats, fileChangeStatsFromPatch } from '../../common/lucosFileChangeStats.js';

suite('Lucos file change stats', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('create counts added lines', () => {
		const stats = computeLineChangeStats('', 'a\nb\nc\n');
		assert.strictEqual(stats.added, 3);
		assert.strictEqual(stats.removed, 0);
	});

	test('delete counts removed lines', () => {
		const stats = computeLineChangeStats('a\nb\nc\n', '');
		assert.strictEqual(stats.added, 0);
		assert.strictEqual(stats.removed, 3);
	});

	test('update counts insertions and deletions', () => {
		const stats = computeLineChangeStats('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
		assert.ok(stats.added >= 1);
		assert.ok(stats.removed >= 1);
	});

	test('aggregates duplicate paths from a patch', () => {
		const files = fileChangeStatsFromPatch({
			patchId: 'p1',
			summary: 'edit',
			fileChanges: [
				{ path: 'a.ts', oldText: 'x\n', newText: 'x\ny\n' },
				{ path: 'a.ts', oldText: 'x\ny\n', newText: 'x\ny\nz\n' },
			],
		});
		assert.strictEqual(files.length, 1);
		assert.strictEqual(files[0].path, 'a.ts');
		assert.ok(files[0].added >= 2);
	});
});
