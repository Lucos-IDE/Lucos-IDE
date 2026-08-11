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

/**
 * Placeholder model catalog for the composer picker / settings enum.
 * Selection still flows through the existing StartAgentTask `model` field unchanged.
 */
export const LUCOS_MODELS = [
	// Claude
	{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
	{ id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
	// GPT-5 series
	{ id: 'gpt-5', label: 'GPT-5' },
	{ id: 'gpt-5.4', label: 'GPT-5.4' },
	{ id: 'gpt-5-mini', label: 'GPT-5 Mini' },
	{ id: 'gpt-5-nano', label: 'GPT-5 Nano' },
	{ id: 'gpt-5-pro', label: 'GPT-5 Pro' },
	// GPT-4 series (optional OpenAI)
	{ id: 'gpt-4o', label: 'GPT-4o' },
	{ id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
	// Gemini
	{ id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
	{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
	{ id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
	// DeepSeek
	{ id: 'deepseek-chat', label: 'DeepSeek Chat' },
	{ id: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
] as const;

export type LucosModelId = typeof LUCOS_MODELS[number]['id'];

export const LUCOS_MODEL_IDS: readonly LucosModelId[] = LUCOS_MODELS.map(m => m.id);

export const LUCOS_DEFAULT_MODEL: LucosModelId = 'claude-sonnet-4-6';

export function lucosModelLabel(modelId: string): string {
	const match = LUCOS_MODELS.find(m => m.id === modelId);
	return match?.label ?? modelId;
}

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
