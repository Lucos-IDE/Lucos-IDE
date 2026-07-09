/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — configuration keys (single source of truth for setting ids).
 *  Registered in lucos.contribution.ts; read by the daemon client (TW-161) and others.
 *--------------------------------------------------------------------------------------------*/

export const LucosSettingId = {
	/** Manual override for the daemon gRPC address; empty ⇒ auto-discover from `~/.lucos/daemon.json`. */
	AgentUrl: 'lucos.agent.url',
	/** Default model for chat/edits; the available set is ultimately gated by the user's plan. */
	AgentModel: 'lucos.agent.model',
	/** Stream assistant responses token-by-token. */
	ChatStreaming: 'lucos.chat.streaming',
	/** Globs excluded from `@file`/`@folder` context (TW-164) and local indexing. */
	ContextIgnorePatterns: 'lucos.context.ignorePatterns',
	/** Base URL of the Lucos cloud gateway, used by the IDE for sign-in (TW-198). */
	CloudGatewayUrl: 'lucos.cloud.gatewayUrl',
} as const;

export type LucosSettingId = typeof LucosSettingId[keyof typeof LucosSettingId];

/** Strongly-typed view of the Lucos settings, for consumers reading via IConfigurationService. */
export interface ILucosConfiguration {
	readonly agentUrl: string;
	readonly agentModel: string;
	readonly chatStreaming: boolean;
	readonly contextIgnorePatterns: readonly string[];
	readonly cloudGatewayUrl: string;
}
