/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/lucosChat.css';
import * as dom from '../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { Action } from '../../../../base/common/actions.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILucosMessage, ILucosSession, LucosMessageRole } from '../common/lucosConversation.js';
import { ILucosConversationService } from '../common/lucosConversationService.js';
import { ILucosChatRequest, ILucosChatRequestService } from '../common/lucosChatRequestService.js';
import { windowChatHistory } from '../common/lucosChatHistory.js';
import { resolveEmptyAssistantFallback } from '../common/lucosAssistantSummary.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosPatchProposal, ILucosWorkspaceContext, IStartAgentTaskRequest, LucosConnectionState, LucosPermissionMode, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';
import { taskPayloadString } from '../../../../platform/lucos/common/lucosTaskPayload.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { LucosActivityTimeline } from './lucosActivityTimeline.js';
import { ILucosContextMention, ILucosStaticContextOption, LucosContextPicker, LucosStaticContextKind } from './lucosContextPicker.js';
import { LucosPatchReview } from './lucosPatchReview.js';
import { ILucosAuthModeService } from '../common/lucosAuthModeService.js';

interface ITurnElements {
	readonly turn: HTMLElement;
	readonly body: HTMLElement;
	readonly footer?: HTMLElement;
	readonly typing?: HTMLElement;
}

interface ISessionUiState {
	readonly shownPatchIds: Set<string>;
	pendingPatch?: ILucosPatchProposal;
	streamingAssistantId?: string;
}

/** Max tabs rendered in the strip before overflow history menu. */
const MAX_VISIBLE_TABS = 6;

const LUCOS_MODELS = [
	{ id: 'claude-opus-4-8', label: 'claude-opus-4-8' },
	{ id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
	{ id: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
] as const;

type LucosComposerMode = 'ask' | 'agent';

interface IComposerDropdownItem {
	readonly id: string;
	readonly label: string;
	readonly checked?: boolean;
	readonly run: () => void | Promise<void>;
}

interface IMentionToken {
	readonly start: number;
	readonly query: string;
}

type LucosMentionMenuItem =
	| { readonly kind: 'static'; readonly option: ILucosStaticContextOption }
	| { readonly kind: 'file'; readonly mention: ILucosContextMention };

export class LucosChatViewPane extends ViewPane {

	static readonly ID = 'lucos.chatView';

	private tabsContainer!: HTMLElement;
	private tabsList!: HTMLElement;
	private tabsOverflowButton!: HTMLButtonElement;
	private readonly tabsDisposables = this._register(new DisposableStore());

	private bannerContainer!: HTMLElement;
	private bannerText!: HTMLElement;
	private bannerAction!: HTMLAnchorElement;
	private bannerActionHandler: (() => void) | undefined;

	private timeline!: LucosActivityTimeline;

	private welcomeContainer!: HTMLElement;
	private messagesContainer!: HTMLElement;
	private composerCard!: HTMLElement;
	private chipsContainer!: HTMLElement;
	private inputBox!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private modeButton!: HTMLButtonElement;
	private modelButton!: HTMLButtonElement;
	private composerMode: LucosComposerMode = 'agent';
	private openDropdownAnchor: HTMLElement | undefined;

	private contextPicker!: LucosContextPicker;
	private patchReview!: LucosPatchReview;
	private readonly mentions: ILucosContextMention[] = [];
	private readonly sessionUi = new Map<string, ISessionUiState>();

	/** Active `@` mention menu state. */
	private mentionMenuOpen = false;
	private mentionToken: IMentionToken | undefined;
	private mentionItems: LucosMentionMenuItem[] = [];
	private mentionHighlightIndex = 0;
	private mentionMenuElement: HTMLElement | undefined;
	private mentionHighlightedElement: HTMLElement | undefined;
	private mentionSearchCts: CancellationTokenSource | undefined;
	private mentionSearchTimer: ReturnType<typeof setTimeout> | undefined;
	/** Click listeners for the current mention menu rows (cleared on re-render). */
	private readonly mentionItemDisposables = this._register(new DisposableStore());

	private readonly turnElements = new Map<string, ITurnElements>();
	private readonly markdownDisposables = new Map<string, IDisposable>();
	private readonly pendingUpdates = new Map<string, ILucosMessage>();
	private scheduledFlush: IDisposable | undefined;
	/** Per-session cancel tokens so background tabs can keep streaming. */
	private readonly streamTokens = new Map<string, CancellationTokenSource>();
	private activePatchContainer: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
		@ILucosConversationService private readonly conversationService: ILucosConversationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosAuthService private readonly lucosAuthService: ILucosAuthService,
		@ILucosChatRequestService private readonly chatRequestService: ILucosChatRequestService,
		@ILucosAuthModeService private readonly lucosAuthModeService: ILucosAuthModeService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.conversationService.onDidAddMessage(e => {
			if (e.sessionId === this.conversationService.activeSession.id) {
				this.renderMessage(e.message);
			}
		}));
		this._register(this.conversationService.onDidUpdateMessage(e => {
			if (e.sessionId === this.conversationService.activeSession.id) {
				this.updateMessage(e.message);
			}
		}));
		this._register(this.conversationService.onDidChangeActiveSession(() => this.onActiveSessionChanged()));
		this._register(this.conversationService.onDidChangeSessions(() => this.rebuildSessionTabs()));
		this._register(this.chatRequestService.onDidRequest(request => this.handleExternalRequest(request)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LucosSettingId.AgentModel)) {
				this.updateModelButton();
			}
		}));
		this._register(toDisposable(() => {
			this.scheduledFlush?.dispose();
			for (const cts of this.streamTokens.values()) {
				cts.dispose(true);
			}
			this.streamTokens.clear();
			this.disposeMentionSearch();
			this.hideMentionMenu();
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('lucos-chat');

		// Header: tabs · overflow · new chat (model lives in composer toolbar).
		const header = dom.append(container, dom.$('.lucos-chat-header'));

		this.tabsContainer = dom.append(header, dom.$('.lucos-chat-tabs'));
		this.tabsList = dom.append(this.tabsContainer, dom.$('.lucos-chat-tabs-list'));
		this.tabsOverflowButton = dom.append(this.tabsContainer, dom.$('button.lucos-chat-tabs-overflow')) as HTMLButtonElement;
		this.tabsOverflowButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.ellipsis));
		this.tabsOverflowButton.title = localize('lucos.chat.tabHistory', "Chat history");
		this.tabsOverflowButton.setAttribute('aria-label', localize('lucos.chat.tabHistory', "Chat history"));
		this.tabsOverflowButton.style.display = 'none';
		this._register(dom.addDisposableListener(this.tabsOverflowButton, 'click', e => this.showTabHistoryMenu(e)));

		const newChatButton = dom.append(header, dom.$('button.lucos-chat-new-button')) as HTMLButtonElement;
		newChatButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.add));
		newChatButton.title = localize('lucos.chat.newChat', "New Chat");
		newChatButton.setAttribute('aria-label', localize('lucos.chat.newChat', "New Chat"));
		this._register(dom.addDisposableListener(newChatButton, 'click', () => this.onNewChat()));

		// Banner (TW-172) - connection/auth states.
		this.bannerContainer = dom.append(container, dom.$('.lucos-chat-banner'));
		this.bannerText = dom.append(this.bannerContainer, dom.$('span.lucos-banner-text'));
		this.bannerAction = dom.append(this.bannerContainer, dom.$('a.lucos-banner-action')) as HTMLAnchorElement;
		this._register(dom.addDisposableListener(this.bannerAction, 'click', () => this.bannerActionHandler?.()));

		this.timeline = this._register(new LucosActivityTimeline());
		this.contextPicker = this.instantiationService.createInstance(LucosContextPicker);
		this.patchReview = this._register(this.instantiationService.createInstance(LucosPatchReview));

		// Messages.
		this.messagesContainer = dom.append(container, dom.$('.lucos-chat-messages'));
		this.welcomeContainer = dom.append(this.messagesContainer, dom.$('.lucos-chat-welcome'));
		this.renderWelcome();

		// Composer: chips → borderless textarea → toolbar (mode · model | send).
		// Type `@` in the textarea to attach files / selection / workspace context.
		const composer = dom.append(container, dom.$('.lucos-composer'));
		this.composerCard = dom.append(composer, dom.$('.lucos-composer-card'));

		this.chipsContainer = dom.append(this.composerCard, dom.$('.lucos-composer-chips'));

		this.inputBox = dom.append(this.composerCard, dom.$('textarea.lucos-composer-input')) as HTMLTextAreaElement;
		this.inputBox.placeholder = localize('lucos.chat.inputPlaceholderShort', "Ask Lucos…  Type @ to attach context");
		this.inputBox.rows = 1;

		const toolbar = dom.append(this.composerCard, dom.$('.lucos-composer-toolbar'));
		const toolbarLeft = dom.append(toolbar, dom.$('.lucos-composer-toolbar-left'));

		this.modeButton = dom.append(toolbarLeft, dom.$('button.lucos-composer-mode')) as HTMLButtonElement;
		this.modeButton.setAttribute('aria-haspopup', 'menu');
		this.updateModeButton();
		this._register(dom.addDisposableListener(this.modeButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showModeMenu();
		}));

		this.modelButton = dom.append(toolbarLeft, dom.$('button.lucos-composer-model')) as HTMLButtonElement;
		this.modelButton.setAttribute('aria-haspopup', 'menu');
		this.updateModelButton();
		this._register(dom.addDisposableListener(this.modelButton, 'click', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showModelMenu();
		}));

		this.sendButton = dom.append(toolbar, dom.$('button.lucos-composer-send')) as HTMLButtonElement;
		this.sendButton.classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowUp));
		this.sendButton.title = localize('lucos.chat.send', "Send");
		this.sendButton.setAttribute('aria-label', localize('lucos.chat.send', "Send"));

		this._register(dom.addDisposableListener(this.inputBox, 'keydown', (e: KeyboardEvent) => this.onInputKeyDown(e)));
		this._register(dom.addDisposableListener(this.inputBox, 'input', () => {
			this.resizeInput();
			this.onComposerInput();
		}));
		this._register(dom.addDisposableListener(this.inputBox, 'blur', () => {
			// Delay so click on a mention item can fire first.
			setTimeout(() => {
				if (this.mentionMenuOpen && !this.composerCard.contains(dom.getActiveElement())) {
					this.hideMentionMenu();
				}
			}, 150);
		}));
		this._register(dom.addDisposableListener(this.sendButton, 'click', () => this.onSend()));

		this._register(this.lucosDaemonService.onDidChangeConnectionState(() => this.updateBanner()));
		this._register(this.lucosAuthModeService.onDidChangeMode(() => this.updateBanner()));
		this.updateBanner();

		this.rebuildSessionTabs();
		this.repaintActiveSessionMessages();
	}

	private updateModeButton(): void {
		const label = this.composerMode === 'ask'
			? localize('lucos.chat.mode.ask', "Ask")
			: localize('lucos.chat.mode.agent', "Agent");
		this.modeButton.textContent = '';
		const text = dom.append(this.modeButton, dom.$('span.lucos-composer-pill-label'));
		text.textContent = label;
		const chevron = dom.append(this.modeButton, dom.$('span'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		this.modeButton.title = localize('lucos.chat.mode.title', "Chat mode");
		this.modeButton.setAttribute('aria-label', localize('lucos.chat.mode.title', "Chat mode"));
	}

	private updateModelButton(): void {
		const model = (this.configurationService.getValue<string>(LucosSettingId.AgentModel) ?? '').trim()
			|| localize('lucos.chat.defaultModel', "Default model");
		this.modelButton.textContent = '';
		const text = dom.append(this.modelButton, dom.$('span.lucos-composer-pill-label'));
		text.textContent = model;
		const chevron = dom.append(this.modelButton, dom.$('span'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		this.modelButton.title = localize('lucos.chat.model.title', "Model");
		this.modelButton.setAttribute('aria-label', localize('lucos.chat.model.title', "Model"));
	}

	private showModeMenu(): void {
		if (this.openDropdownAnchor === this.modeButton) {
			this.contextViewService.hideContextView();
			return;
		}
		this.showComposerDropdown(this.modeButton, [
			{
				id: 'agent',
				label: localize('lucos.chat.mode.agent', "Agent"),
				checked: this.composerMode === 'agent',
				run: () => {
					this.composerMode = 'agent';
					this.updateModeButton();
				},
			},
			{
				id: 'ask',
				label: localize('lucos.chat.mode.ask', "Ask"),
				checked: this.composerMode === 'ask',
				run: () => {
					this.composerMode = 'ask';
					this.updateModeButton();
				},
			},
		]);
	}

	private showModelMenu(): void {
		if (this.openDropdownAnchor === this.modelButton) {
			this.contextViewService.hideContextView();
			return;
		}
		const current = (this.configurationService.getValue<string>(LucosSettingId.AgentModel) ?? '').trim();
		this.showComposerDropdown(this.modelButton, LUCOS_MODELS.map(m => ({
			id: m.id,
			label: m.label,
			checked: m.id === current,
			run: async () => {
				await this.configurationService.updateValue(LucosSettingId.AgentModel, m.id);
				this.updateModelButton();
			},
		})));
	}

	private showComposerDropdown(anchor: HTMLElement, items: readonly IComposerDropdownItem[]): void {
		const store = new DisposableStore();
		this.openDropdownAnchor = anchor;
		anchor.classList.add('open');
		this.contextViewService.showContextView({
			getAnchor: () => anchor,
			anchorPosition: AnchorPosition.ABOVE,
			anchorAlignment: AnchorAlignment.LEFT,
			render: container => {
				container.classList.add('lucos-composer-dropdown-host');
				const menu = dom.append(container, dom.$('.lucos-composer-dropdown'));
				menu.setAttribute('role', 'listbox');

				for (const item of items) {
					const option = dom.append(menu, dom.$('button.lucos-composer-dropdown-item')) as HTMLButtonElement;
					option.type = 'button';
					option.setAttribute('role', 'option');
					option.setAttribute('aria-selected', String(!!item.checked));
					if (item.checked) {
						option.classList.add('checked');
					}

					const label = dom.append(option, dom.$('span.lucos-composer-dropdown-label'));
					label.textContent = item.label;
					if (item.checked) {
						const check = dom.append(option, dom.$('span.lucos-composer-dropdown-check'));
						check.classList.add(...ThemeIcon.asClassNameArray(Codicon.check));
					}

					store.add(dom.addDisposableListener(option, 'click', e => {
						e.preventDefault();
						e.stopPropagation();
						void item.run();
						this.contextViewService.hideContextView();
					}));
				}

				return store;
			},
			onHide: () => {
				anchor.classList.remove('open');
				if (this.openDropdownAnchor === anchor) {
					this.openDropdownAnchor = undefined;
				}
				store.dispose();
			},
		});
	}

	private renderWelcome(): void {
		dom.clearNode(this.welcomeContainer);
		const icon = dom.append(this.welcomeContainer, dom.$('span.lucos-chat-welcome-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		dom.append(this.welcomeContainer, dom.$('.lucos-chat-welcome-title')).textContent =
			localize('lucos.chat.welcomeTitle', "Ask Lucos anything");
		dom.append(this.welcomeContainer, dom.$('.lucos-chat-welcome-hint')).textContent =
			localize('lucos.chat.welcomeHint', "Get help understanding, refactoring, and editing your workspace.");
		this.welcomeContainer.style.display = '';
	}

	private hideWelcome(): void {
		this.welcomeContainer.style.display = 'none';
	}

	private onNewChat(): void {
		// Leave any background streams running; newSession activates a fresh tab.
		this.conversationService.newSession();
	}

	private onActiveSessionChanged(): void {
		this.resetConversationView();
		this.repaintActiveSessionMessages();
		this.restoreActiveSessionChrome();
		this.rebuildSessionTabs();
		this.syncStreamingUi();
	}

	private resetConversationView(): void {
		this.timeline.unmount();
		this.timeline.clear();
		this.activePatchContainer = undefined;

		for (const disposable of this.markdownDisposables.values()) {
			disposable.dispose();
		}
		this.markdownDisposables.clear();
		this.turnElements.clear();
		this.pendingUpdates.clear();
		this.scheduledFlush?.dispose();
		this.scheduledFlush = undefined;

		dom.clearNode(this.messagesContainer);
		this.welcomeContainer = dom.append(this.messagesContainer, dom.$('.lucos-chat-welcome'));
		this.renderWelcome();
		this.clearContext();
		this.resizeInput();
	}

	private repaintActiveSessionMessages(): void {
		for (const message of this.conversationService.activeSession.messages) {
			this.renderMessage(message);
		}
	}

	private restoreActiveSessionChrome(): void {
		const sessionId = this.conversationService.activeSession.id;
		const ui = this.sessionUi.get(sessionId);
		const assistantId = ui?.streamingAssistantId
			?? [...this.conversationService.activeSession.messages].reverse().find(m => m.role === LucosMessageRole.Assistant)?.id;
		if (assistantId && this.turnElements.has(assistantId)) {
			this.mountActiveTurnFooter(assistantId);
		}
		if (ui?.pendingPatch && this.activePatchContainer) {
			this.patchReview.render(this.activePatchContainer, ui.pendingPatch, () => {
				const state = this.getSessionUi(sessionId);
				state.pendingPatch = undefined;
				this.clearPatchReview();
			});
			this.activePatchContainer.classList.add('visible');
		}
	}

	private getSessionUi(sessionId: string): ISessionUiState {
		let state = this.sessionUi.get(sessionId);
		if (!state) {
			state = { shownPatchIds: new Set<string>() };
			this.sessionUi.set(sessionId, state);
		}
		return state;
	}

	private onSend(): void {
		const activeId = this.conversationService.activeSession.id;
		const activeCts = this.streamTokens.get(activeId);
		if (activeCts) {
			activeCts.cancel();
			return;
		}

		const text = this.inputBox.value.trim();
		if (!text) {
			return;
		}
		this.inputBox.value = '';
		this.resizeInput();
		void this.runTask(text);
	}

	private resizeInput(): void {
		this.inputBox.style.height = 'auto';
		this.inputBox.style.height = `${Math.min(this.inputBox.scrollHeight, 160)}px`;
	}

	private async runTask(goal: string, contextOverride?: ILucosWorkspaceContext, selectedAgentPath?: string): Promise<void> {
		if (!this.lucosAuthModeService.requireCloud(this.notificationService)) {
			return;
		}
		const sessionId = this.conversationService.activeSession.id;
		const isActive = () => this.conversationService.activeSession.id === sessionId;
		const ui = this.getSessionUi(sessionId);

		if (isActive()) {
			this.timeline.clear();
			this.clearPatchReview();
		}
		ui.shownPatchIds.clear();
		ui.pendingPatch = undefined;

		// Snapshot prior turns before appending the new user/assistant messages.
		const history = windowChatHistory(this.conversationService.activeSession.messages);

		this.conversationService.addMessage(LucosMessageRole.User, goal);
		const assistant = this.conversationService.addMessage(LucosMessageRole.Assistant, '', true);
		ui.streamingAssistantId = assistant.id;
		if (isActive()) {
			this.mountActiveTurnFooter(assistant.id);
		}

		const cts = new CancellationTokenSource();
		this.streamTokens.set(sessionId, cts);
		this.syncStreamingUi();
		if (isActive()) {
			this.setTypingIndicator(assistant.id, true);
		}

		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		const model = (this.configurationService.getValue<string>(LucosSettingId.AgentModel) ?? '').trim();
		const permissionModeSetting = this.configurationService.getValue<string>(LucosSettingId.AgentPermissionMode) ?? 'auto';
		// Ask mode: prefer manual approvals so patches/commands don't auto-run; instruct model not to edit.
		const permissionMode = this.composerMode === 'ask' || permissionModeSetting === 'manual'
			? LucosPermissionMode.Manual
			: LucosPermissionMode.Auto;
		const taskGoal = this.composerMode === 'ask'
			? `${goal}\n\n[Lucos Ask mode: answer and explain only. Do not call propose_patch, write_file, or apply edits.]`
			: goal;
		const request: IStartAgentTaskRequest = {
			goal: taskGoal,
			sessionId,
			model: model || undefined,
			permissionMode,
			context: { ...(contextOverride ?? this.buildContext()), workspaceRoot },
			selectedAgentPath,
			history,
		};
		if (!contextOverride) {
			this.clearContext();
		}

		let completionSummary: string | undefined;

		try {
			for await (const event of this.lucosDaemonService.startAgentTask(request, cts.token)) {
				if (isActive()) {
					this.timeline.handleEvent(event);
				}
				switch (event.kind) {
					case LucosTaskEventKind.ModelDelta: {
						const delta = taskPayloadString(event.payload, 'textDelta', 'text_delta') ?? '';
						this.conversationService.appendToMessage(assistant.id, delta);
						break;
					}
					case LucosTaskEventKind.AuthRequired:
					case LucosTaskEventKind.AuthExpired:
						this.promptSignIn();
						break;
					case LucosTaskEventKind.AuthForbidden:
					case LucosTaskEventKind.QuotaExceeded: {
						const payload = event.payload as { code?: string; message?: string };
						const detail = payload.message ?? payload.code;
						this.notificationService.notify({
							severity: Severity.Warning,
							message: detail
								? localize('lucos.auth.forbidden.detail', "{0}", detail)
								: localize('lucos.auth.forbidden', "This action isn't available on your current Lucos plan."),
						});
						break;
					}
					case LucosTaskEventKind.PatchProposed: {
						const payload = event.payload as { patchId?: string; patch_id?: string };
						const patchId = payload.patchId ?? payload.patch_id;
						if (patchId) {
							await this.showPatch(sessionId, patchId, assistant.id);
						}
						break;
					}
					case LucosTaskEventKind.TaskCompleted: {
						completionSummary = taskPayloadString(event.payload, 'summary', 'summary') ?? undefined;
						if (isActive()) {
							this.timeline.finish();
						}
						break;
					}
					case LucosTaskEventKind.Error: {
						completionSummary = taskPayloadString(event.payload, 'message', 'message')
							?? taskPayloadString(event.payload, 'summary', 'summary')
							?? undefined;
						if (isActive()) {
							this.timeline.finish();
						}
						break;
					}
				}
			}
		} catch (error) {
			this.conversationService.appendToMessage(assistant.id, `\n\n[error] ${error}`);
		} finally {
			if (isActive()) {
				this.timeline.finish();
				this.setTypingIndicator(assistant.id, false);
			}
			this.ensureAssistantSummary(assistant.id, sessionId, goal, completionSummary);
			this.conversationService.completeMessage(assistant.id);
			ui.streamingAssistantId = undefined;
			if (this.streamTokens.get(sessionId) === cts) {
				this.streamTokens.delete(sessionId);
			}
			cts.dispose();
			this.syncStreamingUi();
		}
	}

	private mountActiveTurnFooter(messageId: string): void {
		const turn = this.turnElements.get(messageId);
		if (!turn?.footer) {
			return;
		}
		this.timeline.mountTo(turn.footer);
		this.activePatchContainer = dom.append(turn.footer, dom.$('.lucos-chat-patch'));
	}

	private promptSignIn(): void {
		this.notificationService.prompt(
			Severity.Warning,
			localize('lucos.auth.required', "Sign in to use Lucos AI."),
			[{ label: localize('lucos.auth.signIn', "Sign In"), run: () => { void this.lucosAuthService.login(); } }],
		);
	}

	private addContext(mention: ILucosContextMention, token?: IMentionToken): void {
		// Avoid duplicate file chips for the same path.
		if (mention.type === 'file' && mention.path && this.mentions.some(m => m.type === 'file' && m.path === mention.path)) {
			if (token) {
				this.stripMentionToken(token);
			}
			this.hideMentionMenu();
			return;
		}
		this.mentions.push(mention);
		const chip = dom.append(this.chipsContainer, dom.$('span.lucos-chat-chip'));
		chip.textContent = mention.label;
		chip.title = mention.path ?? mention.description ?? mention.label;
		this.chipsContainer.classList.add('has-chips');
		if (token) {
			this.stripMentionToken(token);
		}
		this.hideMentionMenu();
	}

	private clearContext(): void {
		this.hideMentionMenu();
		this.mentions.length = 0;
		dom.clearNode(this.chipsContainer);
		this.chipsContainer.classList.remove('has-chips');
	}

	private buildContext(): ILucosWorkspaceContext | undefined {
		if (!this.mentions.length) {
			return undefined;
		}
		const filePaths = this.mentions.filter(m => m.type === 'file' && m.path).map(m => m.path!);
		return {
			selection: this.mentions.find(m => m.type === 'selection')?.text,
			activeFile: this.mentions.find(m => m.type === 'file' || m.type === 'selection')?.path,
			workspaceId: this.mentions.find(m => m.type === 'workspace')?.workspaceId,
			openBuffers: filePaths.length ? filePaths : undefined,
		};
	}

	// --- @ mention menu -------------------------------------------------------

	private onInputKeyDown(e: KeyboardEvent): void {
		if (this.mentionMenuOpen) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				this.moveMentionHighlight(1);
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				this.moveMentionHighlight(-1);
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				this.acceptMentionHighlight();
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				this.hideMentionMenu();
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			this.onSend();
		}
	}

	private onComposerInput(): void {
		const token = this.detectMentionToken();
		if (!token) {
			this.hideMentionMenu();
			return;
		}
		this.mentionToken = token;
		this.refreshMentionMenu(token);
	}

	/**
	 * Find an active `@query` token: `@` at start-of-input or after whitespace,
	 * with no whitespace between `@` and the caret.
	 */
	private detectMentionToken(): IMentionToken | undefined {
		const value = this.inputBox.value;
		const caret = this.inputBox.selectionStart ?? value.length;
		const before = value.slice(0, caret);
		const at = before.lastIndexOf('@');
		if (at < 0) {
			return undefined;
		}
		if (at > 0 && !/\s/.test(before.charAt(at - 1))) {
			return undefined;
		}
		const query = before.slice(at + 1);
		if (/\s/.test(query)) {
			return undefined;
		}
		return { start: at, query };
	}

	private refreshMentionMenu(token: IMentionToken): void {
		const staticItems: LucosMentionMenuItem[] = this.contextPicker.getStaticOptions(token.query)
			.map(option => ({ kind: 'static' as const, option }));

		// Keep prior file items until the debounced search returns (or clear when query empty).
		const priorFiles = token.query
			? this.mentionItems.filter((i): i is Extract<LucosMentionMenuItem, { kind: 'file' }> => i.kind === 'file')
			: [];
		this.mentionItems = [...staticItems, ...priorFiles];
		this.mentionHighlightIndex = 0;

		if (!this.mentionMenuOpen) {
			this.showMentionMenu();
		} else {
			this.renderMentionMenuItems();
		}

		this.scheduleFileSearch(token.query);
	}

	private scheduleFileSearch(query: string): void {
		if (this.mentionSearchTimer !== undefined) {
			clearTimeout(this.mentionSearchTimer);
			this.mentionSearchTimer = undefined;
		}
		this.mentionSearchCts?.dispose(true);
		this.mentionSearchCts = new CancellationTokenSource();
		const cts = this.mentionSearchCts;
		this.mentionSearchTimer = setTimeout(() => {
			this.mentionSearchTimer = undefined;
			void this.runFileSearch(query, cts);
		}, 120);
	}

	private async runFileSearch(query: string, cts: CancellationTokenSource): Promise<void> {
		try {
			const files = await this.contextPicker.searchFiles(query, cts.token);
			if (cts.token.isCancellationRequested || !this.mentionMenuOpen) {
				return;
			}
			const staticItems = this.mentionItems.filter(i => i.kind === 'static');
			const fileItems: LucosMentionMenuItem[] = files.map(mention => ({ kind: 'file', mention }));
			this.mentionItems = [...staticItems, ...fileItems];
			if (this.mentionHighlightIndex >= this.mentionItems.length) {
				this.mentionHighlightIndex = Math.max(0, this.mentionItems.length - 1);
			}
			this.renderMentionMenuItems();
		} catch {
			// Search failed — keep static options only.
		}
	}

	private showMentionMenu(): void {
		const store = new DisposableStore();
		this.mentionMenuOpen = true;
		this.contextViewService.showContextView({
			getAnchor: () => this.composerCard,
			anchorPosition: AnchorPosition.ABOVE,
			anchorAlignment: AnchorAlignment.LEFT,
			render: container => {
				container.classList.add('lucos-composer-dropdown-host');
				const menu = dom.append(container, dom.$('.lucos-composer-dropdown.lucos-mention-menu'));
				menu.setAttribute('role', 'listbox');
				menu.setAttribute('aria-label', localize('lucos.chat.mentionMenu', "Attach context"));
				this.mentionMenuElement = menu;
				this.renderMentionMenuItems();
				return store;
			},
			onHide: () => {
				this.mentionMenuOpen = false;
				this.mentionMenuElement = undefined;
				this.mentionHighlightedElement = undefined;
				this.mentionToken = undefined;
				this.mentionItems = [];
				this.mentionItemDisposables.clear();
				this.disposeMentionSearch();
				store.dispose();
			},
		});
	}

	private hideMentionMenu(): void {
		if (!this.mentionMenuOpen) {
			this.disposeMentionSearch();
			return;
		}
		this.contextViewService.hideContextView();
	}

	private disposeMentionSearch(): void {
		if (this.mentionSearchTimer !== undefined) {
			clearTimeout(this.mentionSearchTimer);
			this.mentionSearchTimer = undefined;
		}
		this.mentionSearchCts?.dispose(true);
		this.mentionSearchCts = undefined;
	}

	private renderMentionMenuItems(): void {
		const menu = this.mentionMenuElement;
		if (!menu) {
			return;
		}
		dom.clearNode(menu);
		this.mentionItemDisposables.clear();
		this.mentionHighlightedElement = undefined;

		if (!this.mentionItems.length) {
			const empty = dom.append(menu, dom.$('.lucos-mention-empty'));
			empty.textContent = localize('lucos.chat.mentionEmpty', "No matching context");
			return;
		}

		this.mentionItems.forEach((item, index) => {
			const option = dom.append(menu, dom.$('button.lucos-composer-dropdown-item.lucos-mention-item')) as HTMLButtonElement;
			option.type = 'button';
			option.setAttribute('role', 'option');
			option.setAttribute('aria-selected', String(index === this.mentionHighlightIndex));
			if (index === this.mentionHighlightIndex) {
				option.classList.add('highlighted');
				this.mentionHighlightedElement = option;
			}

			const icon = dom.append(option, dom.$('span.lucos-mention-icon'));
			if (item.kind === 'static') {
				const codicon = item.option.kind === 'selection' ? Codicon.selection
					: item.option.kind === 'activeFile' ? Codicon.file
						: Codicon.folder;
				icon.classList.add(...ThemeIcon.asClassNameArray(codicon));
				const label = dom.append(option, dom.$('span.lucos-composer-dropdown-label'));
				label.textContent = item.option.label;
				const desc = dom.append(option, dom.$('span.lucos-mention-desc'));
				desc.textContent = item.option.description;
			} else {
				icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
				const label = dom.append(option, dom.$('span.lucos-composer-dropdown-label'));
				label.textContent = item.mention.label.replace(/^@/, '');
				if (item.mention.description) {
					const desc = dom.append(option, dom.$('span.lucos-mention-desc'));
					desc.textContent = item.mention.description;
				}
			}

			this.mentionItemDisposables.add(dom.addDisposableListener(option, 'mousedown', e => {
				// Prevent textarea blur from closing before click.
				e.preventDefault();
			}));
			this.mentionItemDisposables.add(dom.addDisposableListener(option, 'click', e => {
				e.preventDefault();
				e.stopPropagation();
				this.mentionHighlightIndex = index;
				this.acceptMentionHighlight();
			}));
		});
	}

	private moveMentionHighlight(delta: number): void {
		if (!this.mentionItems.length) {
			return;
		}
		const len = this.mentionItems.length;
		this.mentionHighlightIndex = (this.mentionHighlightIndex + delta + len) % len;
		this.renderMentionMenuItems();
		this.mentionHighlightedElement?.scrollIntoView({ block: 'nearest' });
	}

	private acceptMentionHighlight(): void {
		const item = this.mentionItems[this.mentionHighlightIndex];
		const token = this.mentionToken;
		if (!item || !token) {
			this.hideMentionMenu();
			return;
		}
		if (item.kind === 'file') {
			this.addContext(item.mention, token);
			return;
		}
		const mention = this.contextPicker.captureStatic(item.option.kind as LucosStaticContextKind);
		if (!mention) {
			const missing = item.option.kind === 'selection'
				? localize('lucos.chat.mentionNoSelection', "No editor selection to attach.")
				: item.option.kind === 'activeFile'
					? localize('lucos.chat.mentionNoActiveFile', "No active file to attach.")
					: localize('lucos.chat.mentionNoWorkspace', "No workspace folder open.");
			this.notificationService.notify({ severity: Severity.Info, message: missing });
			this.hideMentionMenu();
			return;
		}
		this.addContext(mention, token);
	}

	private stripMentionToken(token: IMentionToken): void {
		const value = this.inputBox.value;
		const caret = this.inputBox.selectionStart ?? value.length;
		const end = Math.max(caret, token.start + 1 + token.query.length);
		const next = value.slice(0, token.start) + value.slice(end);
		this.inputBox.value = next;
		const pos = token.start;
		this.inputBox.setSelectionRange(pos, pos);
		this.resizeInput();
		this.inputBox.focus();
	}

	private handleExternalRequest(request: ILucosChatRequest): void {
		if (this.streamTokens.has(this.conversationService.activeSession.id)) {
			return;
		}
		void this.runTask(request.goal, request.context, request.selectedAgentPath);
	}

	private async showPatch(sessionId: string, patchId: string, assistantMessageId?: string): Promise<void> {
		const ui = this.getSessionUi(sessionId);
		if (ui.shownPatchIds.has(patchId)) {
			return;
		}
		const patch = await this.lucosDaemonService.getPendingPatch(patchId);
		if (!patch) {
			return;
		}
		ui.shownPatchIds.add(patchId);
		ui.pendingPatch = patch;

		if (assistantMessageId && !this.streamTokens.has(sessionId)) {
			this.ensureAssistantSummary(assistantMessageId, sessionId, undefined, undefined);
		}

		if (this.conversationService.activeSession.id !== sessionId) {
			return;
		}
		const container = this.activePatchContainer;
		if (!container) {
			return;
		}
		this.patchReview.render(container, patch, () => {
			ui.pendingPatch = undefined;
			this.clearPatchReview();
		});
		container.classList.add('visible');
		this.scrollToBottom();
	}

	/** When the model only used tools (no model.delta), surface task/patch summary in the bubble. */
	private ensureAssistantSummary(
		messageId: string,
		sessionId: string,
		goal?: string,
		completionSummary?: string,
	): void {
		const message = this.findMessage(messageId);
		if (!message || message.content.trim()) {
			return;
		}

		const ui = this.getSessionUi(sessionId);
		const resolved = resolveEmptyAssistantFallback({
			completionSummary,
			goal,
			pendingPatch: ui.pendingPatch,
		});
		const text =
			resolved.kind === 'text' ? resolved.text
				: resolved.kind === 'patchReview'
					? localize('lucos.chat.patchOnly', "Review the proposed changes below.")
					: localize('lucos.chat.noWrittenAnswer', "No written answer was returned. Check the activity timeline for tool results.");

		this.conversationService.appendToMessage(messageId, text);
	}

	private findMessage(messageId: string): ILucosMessage | undefined {
		for (const session of this.conversationService.sessions) {
			const message = session.messages.find(m => m.id === messageId);
			if (message) {
				return message;
			}
		}
		return undefined;
	}

	private clearPatchReview(): void {
		if (this.activePatchContainer) {
			dom.clearNode(this.activePatchContainer);
			this.activePatchContainer.classList.remove('visible');
		}
	}

	private syncStreamingUi(): void {
		const streaming = this.streamTokens.has(this.conversationService.activeSession.id);
		this.sendButton.textContent = '';
		this.sendButton.classList.remove(...ThemeIcon.asClassNameArray(Codicon.arrowUp));
		this.sendButton.classList.remove(...ThemeIcon.asClassNameArray(Codicon.primitiveSquare));
		this.sendButton.classList.add(...ThemeIcon.asClassNameArray(streaming ? Codicon.primitiveSquare : Codicon.arrowUp));
		const label = streaming
			? localize('lucos.chat.stop', "Stop")
			: localize('lucos.chat.send', "Send");
		this.sendButton.title = label;
		this.sendButton.setAttribute('aria-label', label);
		this.sendButton.classList.toggle('stop', streaming);
		this.inputBox.disabled = streaming;
	}

	private updateBanner(): void {
		if (this.lucosAuthModeService.isLocalOnly) {
			this.showBanner(
				localize('lucos.banner.localOnly', "Local-only mode - sign in for AI assistance."),
				localize('lucos.banner.signIn', "Sign In"),
				() => void this.lucosAuthService.login(),
			);
		} else if (this.lucosDaemonService.connectionState === LucosConnectionState.Disconnected) {
			this.showBanner(
				localize('lucos.banner.offline', "Lucos agent is offline."),
				localize('lucos.banner.retry', "Retry"),
				() => void this.retryConnection(),
			);
		} else {
			this.hideBanner();
		}
	}

	private async retryConnection(): Promise<void> {
		try {
			const health = await this.lucosDaemonService.health();
			if (health.serving) {
				this.updateBanner();
			}
		} catch {
			// Still offline - leave the banner up.
		}
	}

	private showBanner(text: string, actionLabel?: string, handler?: () => void): void {
		this.bannerText.textContent = text;
		if (actionLabel && handler) {
			this.bannerAction.textContent = actionLabel;
			this.bannerAction.style.display = '';
			this.bannerActionHandler = handler;
		} else {
			this.bannerAction.style.display = 'none';
			this.bannerActionHandler = undefined;
		}
		this.bannerContainer.classList.add('visible');
	}

	private hideBanner(): void {
		this.bannerContainer.classList.remove('visible');
		this.bannerActionHandler = undefined;
	}

	private renderMessage(message: ILucosMessage): void {
		this.hideWelcome();

		const isUser = message.role === LucosMessageRole.User;
		const turn = dom.append(this.messagesContainer, dom.$(`.lucos-turn.${isUser ? 'user' : 'assistant'}`));

		const header = dom.append(turn, dom.$('.lucos-turn-header'));
		if (!isUser) {
			const avatar = dom.append(header, dom.$('.lucos-turn-avatar'));
			avatar.classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		}
		dom.append(header, dom.$('span')).textContent = isUser
			? localize('lucos.chat.you', "You")
			: localize('lucos.chat.assistant', "Lucos");

		const body = dom.append(turn, dom.$('.lucos-turn-body'));
		let footer: HTMLElement | undefined;
		let typing: HTMLElement | undefined;

		if (!isUser) {
			footer = dom.append(turn, dom.$('.lucos-turn-footer'));
			typing = dom.append(turn, dom.$('.lucos-typing'));
			const dots = dom.append(typing, dom.$('.lucos-typing-dots'));
			for (let i = 0; i < 3; i++) {
				dom.append(dots, dom.$('span'));
			}
			dom.append(typing, dom.$('span')).textContent = localize('lucos.chat.thinking', "Thinking");
		}

		this.turnElements.set(message.id, { turn, body, footer, typing });
		this.paintMessageBody(message);
		this.setTypingIndicator(message.id, message.streaming);
		this.scrollToBottom();
	}

	private paintMessageBody(message: ILucosMessage): void {
		const turn = this.turnElements.get(message.id);
		if (!turn) {
			return;
		}

		if (message.role === LucosMessageRole.User) {
			turn.body.textContent = message.content;
			return;
		}

		this.markdownDisposables.get(message.id)?.dispose();
		const store = new DisposableStore();
		this.markdownDisposables.set(message.id, store);

		dom.clearNode(turn.body);
		if (!message.content && message.streaming) {
			return;
		}

		const markdown = new MarkdownString(message.content, { supportThemeIcons: true, isTrusted: false });
		const rendered = store.add(renderMarkdown(markdown, {
			fillInIncompleteTokens: message.streaming,
		}));
		turn.body.appendChild(rendered.element);
	}

	private updateMessage(message: ILucosMessage): void {
		this.pendingUpdates.set(message.id, message);
		if (!this.scheduledFlush) {
			this.scheduledFlush = dom.scheduleAtNextAnimationFrame(dom.getWindow(this.messagesContainer), () => this.flushUpdates());
		}
	}

	private flushUpdates(): void {
		this.scheduledFlush = undefined;
		for (const message of this.pendingUpdates.values()) {
			this.paintMessageBody(message);
			this.setTypingIndicator(message.id, message.streaming);
		}
		this.pendingUpdates.clear();
		this.scrollToBottom();
	}

	private setTypingIndicator(messageId: string, visible: boolean): void {
		const turn = this.turnElements.get(messageId);
		if (!turn?.typing) {
			return;
		}
		turn.typing.classList.toggle('visible', visible);
	}

	private scrollToBottom(): void {
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	private rebuildSessionTabs(): void {
		if (!this.tabsList) {
			return;
		}
		this.tabsDisposables.clear();
		dom.clearNode(this.tabsList);

		const sessions = this.conversationService.sessions;
		const activeId = this.conversationService.activeSession.id;
		const visible = sessions.slice(0, MAX_VISIBLE_TABS);
		const overflow = sessions.slice(MAX_VISIBLE_TABS);

		for (const session of visible) {
			this.tabsList.appendChild(this.createSessionTab(session, session.id === activeId));
		}

		this.tabsOverflowButton.style.display = overflow.length > 0 ? '' : 'none';

		// Drop UI/stream state for sessions that no longer exist.
		const liveIds = new Set(sessions.map(s => s.id));
		for (const id of [...this.sessionUi.keys()]) {
			if (!liveIds.has(id)) {
				this.sessionUi.delete(id);
			}
		}
		for (const [id, cts] of [...this.streamTokens.entries()]) {
			if (!liveIds.has(id)) {
				cts.dispose(true);
				this.streamTokens.delete(id);
			}
		}
	}

	private createSessionTab(session: ILucosSession, active: boolean): HTMLElement {
		const tab = dom.$('.lucos-chat-tab');
		if (active) {
			tab.classList.add('active');
		}
		tab.title = session.title;
		tab.setAttribute('role', 'tab');
		tab.setAttribute('aria-selected', String(active));

		const label = dom.append(tab, dom.$('.lucos-chat-tab-label'));
		label.textContent = session.title;

		const close = dom.append(tab, dom.$('button.lucos-chat-tab-close')) as HTMLButtonElement;
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		close.title = localize('lucos.chat.closeTab', "Close chat");
		close.setAttribute('aria-label', localize('lucos.chat.closeTab', "Close chat"));

		this.tabsDisposables.add(dom.addDisposableListener(tab, 'click', () => {
			this.conversationService.openSession(session.id);
		}));
		this.tabsDisposables.add(dom.addDisposableListener(close, 'click', e => {
			e.stopPropagation();
			this.closeSessionTab(session.id);
		}));
		this.tabsDisposables.add(dom.addDisposableListener(label, 'dblclick', e => {
			e.stopPropagation();
			this.beginRenameTab(session, label);
		}));

		return tab;
	}

	private closeSessionTab(sessionId: string): void {
		const cts = this.streamTokens.get(sessionId);
		if (cts) {
			cts.dispose(true);
			this.streamTokens.delete(sessionId);
		}
		this.sessionUi.delete(sessionId);
		this.conversationService.closeSession(sessionId);
	}

	private beginRenameTab(session: ILucosSession, label: HTMLElement): void {
		const input = document.createElement('input');
		input.className = 'lucos-chat-tab-rename';
		input.value = session.title;
		input.setAttribute('aria-label', localize('lucos.chat.renameTab', "Rename chat"));
		label.replaceWith(input);
		input.focus();
		input.select();

		const commit = () => {
			const next = input.value.trim();
			if (next) {
				this.conversationService.renameSession(session.id, next);
			} else {
				this.rebuildSessionTabs();
			}
		};
		const cancel = () => this.rebuildSessionTabs();

		const store = new DisposableStore();
		store.add(dom.addDisposableListener(input, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				store.dispose();
				commit();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				store.dispose();
				cancel();
			}
		}));
		store.add(dom.addDisposableListener(input, 'blur', () => {
			store.dispose();
			commit();
		}));
	}

	private showTabHistoryMenu(e: MouseEvent): void {
		const overflow = this.conversationService.sessions.slice(MAX_VISIBLE_TABS);
		if (overflow.length === 0) {
			return;
		}
		const anchor = new StandardMouseEvent(dom.getWindow(this.tabsOverflowButton), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => overflow.map(session => new Action(
				`lucos.chat.openSession.${session.id}`,
				session.title,
				undefined,
				true,
				() => this.conversationService.openSession(session.id),
			)),
		});
	}
}
