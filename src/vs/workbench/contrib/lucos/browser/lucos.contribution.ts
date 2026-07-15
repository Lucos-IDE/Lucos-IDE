/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainer, ViewContainerLocation } from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosConversationService } from '../common/lucosConversationService.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { ILucosChatRequestService } from '../common/lucosChatRequestService.js';
import { ILucosIndexService } from '../common/lucosIndexService.js';
import { LUCOS_FOCUS_CHAT_COMMAND_ID, LUCOS_VIEW_CONTAINER_ID } from './lucosCommands.js';
import { LucosConversationService } from './lucosConversationService.js';
import { LucosChatRequestService } from './lucosChatRequestService.js';
import { LucosAuthService } from './lucosAuthService.js';
import { LucosIndexService } from './lucosIndexService.js';
import { LucosChatViewPane } from './lucosViewPane.js';
import { LucosStatusBarContribution } from './lucosStatusBar.js';
import { LucosAuthRestoreContribution, LucosLoginAction, LucosLogoutAction, LucosGoogleLoginAction } from './lucosLoginActions.js';
import { LucosCmdKAction, LucosExplainAction, LucosGenerateTestsAction, LucosIndexWorkspaceAction, LucosRefactorAction, LucosReviewChangesAction, LucosSelectCustomizationAction } from './lucosEditorActions.js';
import { LucosNotificationsContribution } from './lucosNotifications.js';
import { LucosFirstRunContribution } from './lucosFirstRunContribution.js';
import { LucosWorkspaceIndexWatcher } from './lucosWorkspaceIndexWatcher.js';
import { ILucosAuthModeService } from '../common/lucosAuthModeService.js';
import { LucosAuthModeService } from './lucosAuthModeService.js';
import { LucosAuthCallbackHandler } from './lucosAuthCallbackHandler.js';

//#region Services
// The daemon service is bound per-platform: desktop -> real gRPC client
// (electron-browser/lucos.contribution.ts); web -> stub (browser/lucos.stub.contribution.ts).
// Conversation store (TW-160).
registerSingleton(ILucosConversationService, LucosConversationService, InstantiationType.Delayed);
// Auth orchestration (TW-198).
registerSingleton(ILucosAuthService, LucosAuthService, InstantiationType.Delayed);
// Chat request seam (TW-163/167).
registerSingleton(ILucosChatRequestService, LucosChatRequestService, InstantiationType.Delayed);
// Workspace indexing state (TW-220/169/170).
registerSingleton(ILucosIndexService, LucosIndexService, InstantiationType.Delayed);
// Auth mode / cloud feature-gating (TW-178/197).
registerSingleton(ILucosAuthModeService, LucosAuthModeService, InstantiationType.Delayed);
//#endregion

//#region Settings (TW-168)
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'lucos',
	order: 100,
	title: localize('lucos.configuration.title', "Lucos AI"),
	type: 'object',
	properties: {
		[LucosSettingId.AgentUrl]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('lucos.agent.url', "Manual override for the local Lucos daemon gRPC address (`host:port`). Leave empty to auto-discover from `~/.lucos/daemon.json`."),
			tags: ['lucos'],
		},
		[LucosSettingId.AgentModel]: {
			type: 'string',
			default: 'claude-sonnet-4-6',
			enum: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
			markdownDescription: localize('lucos.agent.model', "Default model for Lucos chat and edits. The available set is ultimately gated by your plan."),
			tags: ['lucos'],
		},
		[LucosSettingId.AgentPermissionMode]: {
			type: 'string',
			default: 'auto',
			enum: ['auto', 'manual'],
			enumDescriptions: [
				localize('lucos.agent.permissionMode.auto', "Auto-approve safe tools (read, search); patches still require review in the IDE."),
				localize('lucos.agent.permissionMode.manual', "Require explicit approval for risky tools before execution."),
			],
			markdownDescription: localize('lucos.agent.permissionMode', "How the daemon handles tool permission prompts for agent tasks."),
			tags: ['lucos'],
		},
		[LucosSettingId.ChatStreaming]: {
			type: 'boolean',
			default: true,
			markdownDescription: localize('lucos.chat.streaming', "Stream assistant responses token-by-token."),
			tags: ['lucos'],
		},
		[LucosSettingId.ContextIgnorePatterns]: {
			type: 'array',
			items: { type: 'string' },
			default: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**'],
			markdownDescription: localize('lucos.context.ignorePatterns', "Glob patterns excluded from `@file`/`@folder` context and local indexing."),
			tags: ['lucos'],
		},
		[LucosSettingId.CloudGatewayUrl]: {
			type: 'string',
			default: 'https://stagingapi.lucos.com',
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('lucos.cloud.gatewayUrl', "Base URL of the Lucos cloud gateway used for sign-in."),
			tags: ['lucos'],
		},
		[LucosSettingId.GoogleClientId]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('lucos.cloud.googleClientId', "Google OAuth client ID for **Sign In with Google**. Obtain this from your Google Cloud Console and set it here to enable Google login."),
			tags: ['lucos'],
		},
		[LucosSettingId.AuthMode]: {
			type: 'string',
			default: 'cloud',
			enum: ['cloud', 'local-only'],
			enumDescriptions: [
				localize('lucos.authMode.cloud', "Full experience: sign in for LLM, semantic search, and cloud indexing."),
				localize('lucos.authMode.localOnly', "Offline / air-gapped: daemon read/grep/git tools available; LLM and cloud features are disabled and the editor is never blocked by missing auth."),
			],
			scope: ConfigurationScope.MACHINE,
			markdownDescription: localize('lucos.authMode.description', "Controls whether cloud-dependent features (LLM, semantic search, cloud indexing) are enabled. Set to `local-only` for air-gapped environments."),
			tags: ['lucos'],
		},
	},
});
//#endregion

//#region Activity Bar view container + view (TW-158)
const lucosViewIcon = registerIcon('lucos-view-icon', Codicon.sparkle, localize('lucos.viewIcon', "View icon of the Lucos AI view."));

// LUCOS_FORK: Lucos owns the default AuxiliaryBar chat slot (Copilot panel registration is commented out).
const viewContainer: ViewContainer = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer({
	id: LUCOS_VIEW_CONTAINER_ID,
	title: localize2('lucos', "Chat"),
	icon: lucosViewIcon,
	order: 1,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [LUCOS_VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: LUCOS_VIEW_CONTAINER_ID,
	hideIfEmpty: false,
}, ViewContainerLocation.AuxiliaryBar, { isDefault: true, doNotRegisterOpenCommand: true });

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews([{
	id: LucosChatViewPane.ID,
	name: localize2('lucos.chat', "AI Chat"),
	containerIcon: lucosViewIcon,
	ctorDescriptor: new SyncDescriptor(LucosChatViewPane),
	canMoveView: true,
	canToggleVisibility: false,
	// The focus command (TW-158) + its keybinding come for free from this descriptor.
	openCommandActionDescriptor: {
		id: LUCOS_FOCUS_CHAT_COMMAND_ID,
		mnemonicTitle: localize({ key: 'miLucos', comment: ['&& denotes a mnemonic'] }, "&&Chat"),
		keybindings: {
			primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI,
			mac: { primary: KeyMod.CtrlCmd | KeyMod.WinCtrl | KeyCode.KeyI },
		},
		order: 1,
	},
}], viewContainer);
//#endregion

//#region Status bar (TW-169)
registerWorkbenchContribution2(LucosStatusBarContribution.ID, LucosStatusBarContribution, WorkbenchPhase.AfterRestored);
//#endregion

//#region Auth (TW-198)
registerAction2(LucosLoginAction);
registerAction2(LucosLogoutAction);
registerAction2(LucosGoogleLoginAction);
registerWorkbenchContribution2(LucosAuthRestoreContribution.ID, LucosAuthRestoreContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(LucosAuthCallbackHandler.ID, LucosAuthCallbackHandler, WorkbenchPhase.AfterRestored);
//#endregion

//#region First-run onboarding (TW-178)
// Must run after AfterRestored so LucosAuthRestoreContribution has already tried to resume the
// stored JWT - that way we skip the prompt for returning authenticated users.
registerWorkbenchContribution2(LucosFirstRunContribution.ID, LucosFirstRunContribution, WorkbenchPhase.AfterRestored);
//#endregion

//#region Workspace-open -> auto-index (TW-178 / TW-220)
registerWorkbenchContribution2(LucosWorkspaceIndexWatcher.ID, LucosWorkspaceIndexWatcher, WorkbenchPhase.AfterRestored);
//#endregion

//#region Editor & palette actions (TW-163 Cmd+K, TW-167)
registerAction2(LucosCmdKAction);
registerAction2(LucosExplainAction);
registerAction2(LucosRefactorAction);
registerAction2(LucosGenerateTestsAction);
registerAction2(LucosReviewChangesAction);
registerAction2(LucosSelectCustomizationAction);
registerAction2(LucosIndexWorkspaceAction);
//#endregion

//#region Notifications (TW-170)
registerWorkbenchContribution2(LucosNotificationsContribution.ID, LucosNotificationsContribution, WorkbenchPhase.AfterRestored);
//#endregion
