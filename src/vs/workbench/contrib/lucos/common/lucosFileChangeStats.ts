/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { linesDiffComputers } from '../../../../editor/common/diff/linesDiffComputers.js';
import { ILucosFileChange, ILucosPatchProposal } from '../../../../platform/lucos/common/lucosProtocol.js';

export interface ILucosFileChangeStat {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
}

function splitLines(text: string): string[] {
	if (text.length === 0) {
		return [''];
	}
	return text.split(/\r\n|\r|\n/);
}

/** Compute insertion/deletion line counts between old and new text. */
export function computeLineChangeStats(oldText: string, newText: string): { added: number; removed: number } {
	const originalLines = splitLines(oldText ?? '');
	const modifiedLines = splitLines(newText ?? '');

	// Pure create
	if (!(oldText ?? '').length && (newText ?? '').length) {
		const lines = modifiedLines[modifiedLines.length - 1] === '' && modifiedLines.length > 1
			? modifiedLines.length - 1
			: modifiedLines.length;
		return { added: Math.max(lines, 1), removed: 0 };
	}
	// Pure delete
	if ((oldText ?? '').length && !(newText ?? '').length) {
		const lines = originalLines[originalLines.length - 1] === '' && originalLines.length > 1
			? originalLines.length - 1
			: originalLines.length;
		return { added: 0, removed: Math.max(lines, 1) };
	}

	const diff = linesDiffComputers.getDefault().computeDiff(originalLines, modifiedLines, {
		ignoreTrimWhitespace: false,
		maxComputationTimeMs: 100,
		computeMoves: false,
	});

	let added = 0;
	let removed = 0;
	for (const change of diff.changes) {
		removed += change.original.endLineNumberExclusive - change.original.startLineNumber;
		added += change.modified.endLineNumberExclusive - change.modified.startLineNumber;
	}
	return { added, removed };
}

export function fileChangeStatsFromPatch(patch: ILucosPatchProposal | undefined): ILucosFileChangeStat[] {
	if (!patch?.fileChanges?.length) {
		return [];
	}
	const byPath = new Map<string, ILucosFileChangeStat>();
	for (const change of patch.fileChanges) {
		const stats = computeLineChangeStats(change.oldText ?? '', change.newText ?? '');
		const existing = byPath.get(change.path);
		if (existing) {
			byPath.set(change.path, {
				path: change.path,
				added: existing.added + stats.added,
				removed: existing.removed + stats.removed,
			});
		} else {
			byPath.set(change.path, { path: change.path, ...stats });
		}
	}
	return [...byPath.values()];
}

export function findPatchFileChange(patch: ILucosPatchProposal | undefined, path: string): ILucosFileChange | undefined {
	return patch?.fileChanges.find(change => change.path === path);
}
