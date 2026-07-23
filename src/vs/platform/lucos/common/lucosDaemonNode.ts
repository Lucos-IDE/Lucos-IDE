/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILucosIndexWorkspaceRequest, ILucosApplyPatchResult, ILucosAuthStatus, ILucosCloudCredentials, ILucosCustomizations, ILucosHealth, ILucosPatchProposal, IStartAgentTaskRequest, ITaskEvent, LucosConnectionState } from './lucosProtocol.js';

export const ipcLucosDaemonChannelName = 'lucosDaemon';

export const ILucosDaemonNodeService = createDecorator<ILucosDaemonNodeService>('lucosDaemonNodeService');

export interface ILucosDaemonNodeService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeConnectionState: Event<LucosConnectionState>;
	readonly onDidChangeAuthStatus: Event<ILucosAuthStatus>;

	getConnectionState(): Promise<LucosConnectionState>;
	getAuthStatus(): Promise<ILucosAuthStatus>;

	health(): Promise<ILucosHealth>;
	setCloudCredentials(credentials: ILucosCloudCredentials): Promise<void>;
	clearCloudCredentials(): Promise<void>;

	/** Begins a task; the stream is consumed via {@link onDynamicAgentTaskEvent}. */
	startAgentTask(request: IStartAgentTaskRequest): Promise<{ taskId: string }>;
	/** Aborts the underlying gRPC stream for a task (ProxyChannel-safe replacement for a token). */
	cancelAgentTask(taskId: string): Promise<void>;
	/** Per-task server-stream. `onDynamic` prefix is required by ProxyChannel for per-call events. */
	onDynamicAgentTaskEvent(taskId: string): Event<ITaskEvent>;

	/** Resolves a pending tool permission request for an active task. */
	respondToPermission(taskId: string, toolCallId: string, approved: boolean, denyReason?: string): Promise<void>;

	//#region Patch flow (TW-165/166)
	getPendingPatch(patchId: string): Promise<ILucosPatchProposal | undefined>;
	applyPatch(patchId: string, workspaceRoot: string): Promise<ILucosApplyPatchResult>;
	rejectPatch(patchId: string): Promise<void>;
	//#endregion

	/** Skills/agents discovered locally (TW-184). */
	listCustomizations(workspaceRoot: string): Promise<ILucosCustomizations>;

	/** Begins indexing (TW-220); the stream reuses {@link onDynamicAgentTaskEvent}/{@link cancelAgentTask}. */
	startIndexWorkspace(request: ILucosIndexWorkspaceRequest): Promise<{ taskId: string }>;

	/**
	 * Stops a daemon process that this Lucos instance spawned.
	 * No-op when the daemon was adopted (e.g. external `make dev`).
	 * Wired from electron-main `onWillShutdown` (node layer cannot import electron-main).
	 */
	shutdownOwnedDaemon(): Promise<void>;
}
