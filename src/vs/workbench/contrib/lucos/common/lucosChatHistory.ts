/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Max prior turns sent with StartAgentTask (most recent first kept, then oldest dropped). */
export const MAX_HISTORY_MESSAGES = 20;

/** Soft cap on total content characters across the history window. */
export const MAX_HISTORY_CHARS = 24000;

/**
 * Build a bounded prior-turn window for `StartAgentTaskRequest.history`.
 * Filters streaming / empty messages, keeps the most recent N within the char budget,
 * and returns chronological (oldest-first) order.
 */
export function windowChatHistory(
	messages: readonly { role: string; content: string; streaming?: boolean }[]
): { role: string; content: string }[] {
	const mapped = messages
		.filter(m => !m.streaming && m.content.trim().length > 0)
		.map(m => ({ role: m.role, content: m.content }));

	const recent = mapped.slice(-MAX_HISTORY_MESSAGES);

	let totalChars = recent.reduce((sum, m) => sum + m.content.length, 0);
	while (recent.length > 0 && totalChars > MAX_HISTORY_CHARS) {
		const dropped = recent.shift()!;
		totalChars -= dropped.content.length;
	}

	return recent;
}
