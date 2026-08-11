/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Daemon `TaskEvent.payload_json` uses snake_case; read either convention. */
export function taskPayloadString(payload: unknown, camelKey: string, snakeKey: string): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	const value = record[camelKey] ?? record[snakeKey];
	return typeof value === 'string' ? value : undefined;
}
