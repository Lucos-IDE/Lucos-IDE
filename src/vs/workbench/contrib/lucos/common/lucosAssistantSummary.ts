/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type EmptyAssistantFallback =
	| { kind: 'text'; text: string }
	| { kind: 'patchReview' }
	| { kind: 'noWrittenAnswer' };

export interface IEmptyAssistantFallbackInput {
	readonly completionSummary?: string;
	readonly goal?: string;
	readonly pendingPatch?: {
		readonly summary?: string;
		readonly fileChanges?: readonly { readonly path: string }[];
	};
}

function isGenericCompletionSummary(text: string): boolean {
	switch (text.trim().toLowerCase()) {
		case 'task completed':
		case 'task completed.':
		case 'task complete':
		case 'task complete.':
			return true;
		default:
			return false;
	}
}

function normalizeCompletionText(text: string | undefined, goal?: string): string {
	const trimmed = text?.trim() ?? '';
	if (!trimmed || isGenericCompletionSummary(trimmed)) {
		return '';
	}
	if (goal && trimmed.toLowerCase() === goal.trim().toLowerCase()) {
		return '';
	}
	return trimmed;
}

/** Strip trailing sentence punctuation for duplicate detection. */
function stripTrailingSentencePunctuation(text: string): string {
	return text.trim().replace(/[.!?…]+$/u, '').trim();
}

/**
 * True when `candidate` is already covered by `existing` (exact substring, or
 * same text ignoring trailing punctuation / last-sentence overlap).
 */
function contentAlreadyCovers(existing: string, candidate: string): boolean {
	if (!candidate) {
		return true;
	}
	if (existing.includes(candidate)) {
		return true;
	}
	const normExisting = stripTrailingSentencePunctuation(existing);
	const normCandidate = stripTrailingSentencePunctuation(candidate);
	if (!normCandidate) {
		return true;
	}
	if (normExisting.includes(normCandidate)) {
		return true;
	}
	const lastSentence = normExisting.split(/[.!?…]+\s+/u).pop() ?? normExisting;
	return stripTrailingSentencePunctuation(lastSentence) === normCandidate;
}

/**
 * Resolves chat-bubble fallback copy when the assistant message has no streamed content.
 * Localization of kind markers is left to the caller.
 */
export function resolveEmptyAssistantFallback(input: IEmptyAssistantFallbackInput): EmptyAssistantFallback {
	const patch = input.pendingPatch;
	const patchSummary = normalizeCompletionText(patch?.summary);
	const completion = normalizeCompletionText(input.completionSummary, input.goal);

	if (patch) {
		if (patchSummary) {
			return { kind: 'text', text: patchSummary };
		}
		const files = (patch.fileChanges ?? [])
			.map(f => f.path?.trim())
			.filter((p): p is string => !!p);
		if (files.length > 0) {
			const shown = files.slice(0, 3);
			const extra = files.length > 3 ? `, and ${files.length - 3} more` : '';
			return { kind: 'text', text: `Proposed changes to ${shown.join(', ')}${extra}` };
		}
		return { kind: 'patchReview' };
	}

	if (completion) {
		return { kind: 'text', text: completion };
	}

	return { kind: 'noWrittenAnswer' };
}

/**
 * When the bubble already has a short preamble (e.g. "Let me read the README"),
 * returns meaningful completion text to append — or `undefined` if nothing new to add
 * (generic summary, duplicate of existing content, or empty).
 */
export function resolveCompletionAppend(
	existingContent: string,
	input: IEmptyAssistantFallbackInput,
): string | undefined {
	const patchSummary = normalizeCompletionText(input.pendingPatch?.summary);
	const completion = normalizeCompletionText(input.completionSummary, input.goal);
	const candidate = patchSummary || completion;
	if (!candidate) {
		return undefined;
	}
	const existing = existingContent.trim();
	if (existing && contentAlreadyCovers(existing, candidate)) {
		return undefined;
	}
	return candidate;
}

/**
 * Strip daemon truncation markers and control bytes before markdown render.
 * Also normalizes accidental double sentence punctuation (`..`, `. .`) without
 * collapsing intentional ellipsis (`...`).
 */
export function sanitizeAssistantText(raw: string): string {
	let text = raw.replace(/\n?…\s*\[truncated \d+ bytes\]/g, '');
	text = text.replace(/\n?(?:\.{3}|…)?\s*\[truncated \d+ bytes\]/gi, '');
	// C0/C1 controls except tab/LF/CR
	text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
	// Collapse accidental double punctuation (`..`, `!!`) but keep ellipsis (`...`).
	text = text.replace(/([.!?])\1+(?!\1)/g, (match, ch: string) => (match.length === 2 ? ch : match));
	// ". ."
	text = text.replace(/([.!?])\s+\./g, '$1');
	return text;
}

const TOOL_NARRATION_PREFIXES = [
	'reading ',
	'searching for ',
	'searching the web for ',
	'semantic search',
	'proposing ',
	'requesting approval',
	'working on ',
	'running ',
] as const;

/** True when text is only synthetic tool status lines (e.g. "Reading foo.go"). */
export function isToolNarrationOnly(text: string): boolean {
	const cleaned = text.trim();
	if (!cleaned) {
		return false;
	}
	let hasLine = false;
	for (const raw of cleaned.split(/\n|;/)) {
		const line = raw.trim().replace(/[.…]+$/u, '').trim();
		if (!line) {
			continue;
		}
		hasLine = true;
		const lowered = line.toLowerCase();
		if (!TOOL_NARRATION_PREFIXES.some(prefix => lowered.startsWith(prefix))) {
			return false;
		}
	}
	return hasLine;
}

/**
 * Remove tool-status narration lines/sentences so the bubble keeps the real answer.
 * Returns empty string when nothing but narration remains.
 */
export function stripToolNarration(text: string): string {
	const cleaned = text.trim();
	if (!cleaned) {
		return '';
	}
	if (isToolNarrationOnly(cleaned)) {
		return '';
	}

	const kept: string[] = [];
	for (const raw of cleaned.split('\n')) {
		const line = raw.trim();
		if (!line) {
			if (kept.length > 0 && kept[kept.length - 1] !== '') {
				kept.push('');
			}
			continue;
		}
		// Split accidental glued sentences: "Reading a.ts.Here is the answer."
		const pieces = line.split(/(?<=[.!?…])(?:\s+|(?=[A-Z]))/u);
		const keptPieces: string[] = [];
		for (const piece of pieces) {
			const normalized = piece.trim().replace(/[.…]+$/u, '').trim();
			const lowered = normalized.toLowerCase();
			if (TOOL_NARRATION_PREFIXES.some(prefix => lowered.startsWith(prefix))) {
				continue;
			}
			keptPieces.push(piece.trim());
		}
		if (keptPieces.length > 0) {
			kept.push(keptPieces.join(' '));
		}
	}
	return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
