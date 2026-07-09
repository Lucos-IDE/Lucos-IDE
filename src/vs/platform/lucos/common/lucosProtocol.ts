/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — shared protocol/contract types mirroring the Lucos daemon gRPC surface
 *  (proto package `lucos.v1`, service `LucosDaemon`).
 *
 *  These live in `platform/` because they are shared across the IPC boundary: the main-process
 *  node service and the renderer both depend on them, and only `platform`/`base`/`common` are
 *  importable from both sides.
 *--------------------------------------------------------------------------------------------*/

/** Transport connection state between the IDE and the local Lucos daemon. */
export const enum LucosConnectionState {
	Disconnected = 'disconnected',
	Connecting = 'connecting',
	Connected = 'connected',
}

/** Result of the daemon `Health` RPC. */
export interface ILucosHealth {
	readonly serving: boolean;
	readonly version: string;
}

/** Auth lifecycle state — mirrors the daemon `AuthState` enum (TW-190, done). */
export const enum LucosAuthState {
	Unspecified = 'unspecified',
	Unauthenticated = 'unauthenticated',
	Authenticating = 'authenticating',
	Authenticated = 'authenticated',
	TokenExpired = 'token_expired',
	CloudUnreachable = 'cloud_unreachable',
	OfflineMode = 'offline_mode',
}

/** Result of the daemon `GetAuthStatus` RPC. */
export interface ILucosAuthStatus {
	readonly state: LucosAuthState;
	readonly userId?: string;
	readonly orgId?: string;
	readonly planCode?: string;
	readonly roles?: readonly string[];
	readonly cloudReachable: boolean;
	/** Epoch milliseconds. */
	readonly tokenExpiresAt?: number;
}

/** Credentials handed to the daemon after login — `SetCloudCredentials` RPC (TW-190, TW-198). */
export interface ILucosCloudCredentials {
	readonly accessToken: string;
	/** Epoch milliseconds. */
	readonly expiresAt?: number;
	readonly userId?: string;
	readonly orgId?: string;
	readonly gatewayUrl?: string;
}

/** Visible editor context captured by the IDE and sent with a task (`StartAgentTaskRequest`). */
export interface ILucosWorkspaceContext {
	readonly workspaceId?: string;
	/** Absolute path of the active workspace root — required by the daemon's file tools (TW-161). */
	readonly workspaceRoot?: string;
	readonly activeFile?: string;
	readonly selection?: string;
	readonly openBuffers?: readonly string[];
}

/** Permission mode governing risky tools (patch apply, command run). */
export const enum LucosPermissionMode {
	Auto = 'auto',
	Manual = 'manual',
}

/** Request to start an autonomous agent task — `StartAgentTask` RPC. */
export interface IStartAgentTaskRequest {
	readonly goal: string;
	readonly sessionId: string;
	readonly model?: string;
	readonly permissionMode?: LucosPermissionMode;
	readonly context?: ILucosWorkspaceContext;
	/** Path of a selected skill/agent customization to run with (TW-184). */
	readonly selectedAgentPath?: string;
}

/**
 * Task event kinds streamed from the daemon (`TaskEvent.event_type`). Modelled as string
 * literals so unknown/future kinds pass through the UI untouched instead of breaking it.
 */
export const enum LucosTaskEventKind {
	TaskStarted = 'task.started',
	ModelDelta = 'model.delta',
	ToolStarted = 'tool.started',
	ToolCompleted = 'tool.completed',
	PermissionRequested = 'permission.requested',
	PatchProposed = 'patch.proposed',
	TaskCompleted = 'task.completed',
	AuthRequired = 'auth.required',
	AuthExpired = 'auth.expired',
	AuthForbidden = 'auth.forbidden',
	QuotaExceeded = 'quota.exceeded',
	// Index lifecycle (TW-220) — streamed from IndexWorkspace.
	IndexStarted = 'index.started',
	IndexProgress = 'index.progress',
	IndexUploadStarted = 'index.upload.started',
	IndexUploadProgress = 'index.upload.progress',
	IndexCloudStatus = 'index.cloud.status',
	IndexCompleted = 'index.completed',
	IndexFailed = 'index.failed',
	Error = 'error',
}

/**
 * A single event in the agent task stream. `payload` is the parsed `TaskEvent.payload_json`;
 * consumers narrow it by `kind`. `kind` is intentionally `LucosTaskEventKind | string` so an
 * unrecognised event never crashes the renderer.
 */
export interface ITaskEvent {
	readonly taskId: string;
	readonly kind: LucosTaskEventKind | string;
	readonly sequence: number;
	/** Epoch milliseconds. */
	readonly timestamp: number;
	readonly severity: string;
	readonly payload: unknown;
}

/** A single file change within a proposed patch (`FileChange`) — TW-165/166. */
export interface ILucosFileChange {
	readonly path: string;
	readonly oldText: string;
	readonly newText: string;
	readonly baseHash?: string;
}

/** A proposed multi-file patch held by the daemon (`PatchProposal`). The daemon applies it on accept. */
export interface ILucosPatchProposal {
	readonly patchId: string;
	readonly taskId?: string;
	readonly summary: string;
	readonly fileChanges: readonly ILucosFileChange[];
	readonly status?: string;
}

/** Result of applying a patch (`ApplyPatchResponse`). */
export interface ILucosApplyPatchResult {
	readonly patchId: string;
	readonly filesChanged: readonly string[];
}

/** A repo/user skill (`SkillEntry`) — TW-184. */
export interface ILucosSkill {
	readonly name: string;
	readonly description: string;
	readonly path: string;
	readonly scope: string;
	readonly userInvocable: boolean;
}

/** A repo/user sub-agent (`AgentEntry`) — TW-184. */
export interface ILucosAgent {
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly path: string;
	readonly scope: string;
	readonly model?: string;
}

/** Skills + agents discovered by the daemon for a workspace (`CustomizationsSnapshot`). */
export interface ILucosCustomizations {
	readonly skills: readonly ILucosSkill[];
	readonly agents: readonly ILucosAgent[];
}

/** Request to (re)index a workspace — `IndexWorkspaceRequest` (TW-220). */
export interface ILucosIndexWorkspaceRequest {
	readonly workspaceRoot: string;
	readonly workspaceId?: string;
	readonly forceRescan?: boolean;
	readonly ignorePatterns?: readonly string[];
}

/** IDE-facing indexing state derived from the `index.*` event stream (TW-169). */
export const enum LucosIndexState {
	Idle = 'idle',
	Indexing = 'indexing',
	Indexed = 'indexed',
	Stale = 'stale',
	Failed = 'failed',
}

export interface ILucosIndexStatus {
	readonly state: LucosIndexState;
	readonly filesIndexed?: number;
	readonly chunksTotal?: number;
	readonly staleCount?: number;
	readonly message?: string;
}
