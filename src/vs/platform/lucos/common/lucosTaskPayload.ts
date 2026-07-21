/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILucosPermissionRequest } from './lucosProtocol.js';

/** Daemon `TaskEvent.payload_json` uses snake_case; read either convention. */
export function taskPayloadString(payload: unknown, camelKey: string, snakeKey: string): string | undefined {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const record = payload as Record<string, unknown>;
	const value = record[camelKey] ?? record[snakeKey];
	return typeof value === 'string' ? value : undefined;
}

/** Parse a `permission.requested` payload into a typed request (TW-175 Phase 2b). */
export function parsePermissionRequest(taskId: string, payload: unknown): ILucosPermissionRequest | undefined {
	const toolCallId = taskPayloadString(payload, 'toolCallId', 'tool_call_id');
	if (!toolCallId) {
		return undefined;
	}
	const toolName = taskPayloadString(payload, 'toolName', 'tool_name') ?? 'run_command';
	const command = taskPayloadString(payload, 'command', 'command')
		?? taskPayloadString(payload, 'commandOrPath', 'command_or_path');
	const cwd = taskPayloadString(payload, 'cwd', 'cwd');
	const reason = taskPayloadString(payload, 'reason', 'reason');
	return { taskId, toolCallId, toolName, command, cwd, reason };
}
