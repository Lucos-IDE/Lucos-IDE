/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LcsDiff, ISequence } from '../../../../base/common/diff/diff.js';

/** A rendered diff row. `gap` collapses a run of unchanged lines (Cursor/GitHub style). */
export type LucosDiffRowType = 'context' | 'add' | 'del' | 'gap';

export interface ILucosDiffRow {
	readonly type: LucosDiffRowType;
	/** Line content for context/add/del rows; empty for gap rows. */
	readonly text: string;
	/** 1-based line number in the original file (context + del rows). */
	readonly oldLine?: number;
	/** 1-based line number in the modified file (context + add rows). */
	readonly newLine?: number;
	/** Number of unchanged lines hidden by a `gap` row. */
	readonly hiddenCount?: number;
}

export interface ILucosFileDiff {
	readonly rows: readonly ILucosDiffRow[];
	readonly additions: number;
	readonly deletions: number;
	/** True when the file is new (no prior content). */
	readonly isNew: boolean;
	/** True when the file is being deleted (no new content). */
	readonly isDeleted: boolean;
	/** True when rows were capped by `maxRows`. */
	readonly truncated: boolean;
}

export interface ILucosDiffOptions {
	/** Unchanged lines kept around each change. Default 3. */
	readonly contextLines?: number;
	/** Hard cap on emitted rows before truncating. Default 600. */
	readonly maxRows?: number;
}

/** Split text into lines, tolerating CRLF/CR and a single trailing newline. */
function toLines(text: string): string[] {
	if (text === '') {
		return [];
	}
	const normalized = text.replace(/\r\n?/g, '\n');
	const lines = normalized.split('\n');
	// A trailing newline yields a spurious final empty element — drop it.
	if (lines.length > 1 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** Map each distinct line to a stable integer id so LcsDiff can compare by value. */
class LineSequence implements ISequence {
	public readonly ids: number[];
	constructor(lines: string[], intern: Map<string, number>) {
		this.ids = lines.map(line => {
			let id = intern.get(line);
			if (id === undefined) {
				id = intern.size;
				intern.set(line, id);
			}
			return id;
		});
	}
	getElements(): number[] {
		return this.ids;
	}
}

/**
 * Compute a line-level diff between two texts, returning renderable rows plus
 * add/delete stats. Long runs of unchanged lines are collapsed into `gap` rows.
 */
export function computeLineDiff(oldText: string, newText: string, options?: ILucosDiffOptions): ILucosFileDiff {
	const contextLines = Math.max(0, options?.contextLines ?? 3);
	const maxRows = Math.max(1, options?.maxRows ?? 600);

	const oldLines = toLines(oldText);
	const newLines = toLines(newText);
	const isNew = oldLines.length === 0 && newLines.length > 0;
	const isDeleted = newLines.length === 0 && oldLines.length > 0;

	const intern = new Map<string, number>();
	const original = new LineSequence(oldLines, intern);
	const modified = new LineSequence(newLines, intern);
	const changes = new LcsDiff(original, modified).ComputeDiff(true).changes;

	const full: ILucosDiffRow[] = [];
	let additions = 0;
	let deletions = 0;
	let oIdx = 0;
	let mIdx = 0;

	for (const change of changes) {
		while (oIdx < change.originalStart) {
			full.push({ type: 'context', text: oldLines[oIdx], oldLine: oIdx + 1, newLine: mIdx + 1 });
			oIdx++;
			mIdx++;
		}
		for (let k = 0; k < change.originalLength; k++) {
			full.push({ type: 'del', text: oldLines[oIdx], oldLine: oIdx + 1 });
			oIdx++;
			deletions++;
		}
		for (let k = 0; k < change.modifiedLength; k++) {
			full.push({ type: 'add', text: newLines[mIdx], newLine: mIdx + 1 });
			mIdx++;
			additions++;
		}
	}
	while (oIdx < oldLines.length) {
		full.push({ type: 'context', text: oldLines[oIdx], oldLine: oIdx + 1, newLine: mIdx + 1 });
		oIdx++;
		mIdx++;
	}

	const collapsed = collapseContext(full, contextLines);
	const truncated = collapsed.length > maxRows;
	const rows = truncated ? collapsed.slice(0, maxRows) : collapsed;

	return { rows, additions, deletions, isNew, isDeleted, truncated };
}

/**
 * Replace long runs of unchanged lines with a single `gap` row, keeping `contextLines`
 * of context adjacent to each change. Runs at the file's start/end only keep the side
 * facing a change.
 */
function collapseContext(rows: ILucosDiffRow[], contextLines: number): ILucosDiffRow[] {
	const result: ILucosDiffRow[] = [];
	let i = 0;
	while (i < rows.length) {
		if (rows[i].type !== 'context') {
			result.push(rows[i]);
			i++;
			continue;
		}
		let j = i;
		while (j < rows.length && rows[j].type === 'context') {
			j++;
		}
		const run = rows.slice(i, j);
		const atStart = i === 0;
		const atEnd = j === rows.length;
		const head = atStart ? 0 : contextLines;
		const tail = atEnd ? 0 : contextLines;

		if (run.length <= head + tail) {
			result.push(...run);
		} else {
			const hidden = run.length - head - tail;
			for (let k = 0; k < head; k++) {
				result.push(run[k]);
			}
			result.push({ type: 'gap', text: '', hiddenCount: hidden });
			for (let k = run.length - tail; k < run.length; k++) {
				result.push(run[k]);
			}
		}
		i = j;
	}
	return result;
}
