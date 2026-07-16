/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const LucosSettingId = {
	/** Displays signed-in user account information (read-only). */
	AccountInfo: 'lucos.account.info',
	/** Manual override for the daemon gRPC address; empty -> auto-discover from `~/.lucos/daemon.json`. */
	AgentUrl: 'lucos.agent.url',
	/** Default model for chat/edits; the available set is ultimately gated by the user's plan. */
	AgentModel: 'lucos.agent.model',
	/** Permission mode for risky tools: auto-approve safe reads, manual for patches/commands. */
	AgentPermissionMode: 'lucos.agent.permissionMode',
	/** Stream assistant responses token-by-token. */
	ChatStreaming: 'lucos.chat.streaming',
	/** Globs excluded from `@file`/`@folder` context (TW-164) and local indexing. */
	ContextIgnorePatterns: 'lucos.context.ignorePatterns',
	/** Base URL of the Lucos cloud gateway, used by the IDE for sign-in (TW-198). */
	CloudGatewayUrl: 'lucos.cloud.gatewayUrl',
	/** Google OAuth client ID used to initiate browser-based Google sign-in. */
	GoogleClientId: 'lucos.cloud.googleClientId',
	/**
	 * Auth / feature mode (TW-178 / TW-197).
	 * - `cloud`      (default) - full experience: sign in once, LLM + semantic search + cloud indexing.
	 * - `local-only` - offline/air-gapped: daemon read/grep/git tools available; LLM + cloud features
	 *                  are disabled and the user is never blocked by missing auth.
	 */
	AuthMode: 'lucos.auth.mode',
} as const;

export type LucosSettingId = typeof LucosSettingId[keyof typeof LucosSettingId];

/** Strongly-typed view of the Lucos settings, for consumers reading via IConfigurationService. */
export interface ILucosConfiguration {
	readonly accountInfo: string;
	readonly agentUrl: string;
	readonly agentModel: string;
	readonly agentPermissionMode: 'auto' | 'manual';
	readonly chatStreaming: boolean;
	readonly contextIgnorePatterns: readonly string[];
	readonly cloudGatewayUrl: string;
	readonly authMode: 'cloud' | 'local-only';
}
