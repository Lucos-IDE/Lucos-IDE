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
