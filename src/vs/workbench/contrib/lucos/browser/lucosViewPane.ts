/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { ILucosMessage, LucosMessageRole } from '../common/lucosConversation.js';
import { ILucosConversationService } from '../common/lucosConversationService.js';
import { ILucosChatRequest, ILucosChatRequestService } from '../common/lucosChatRequestService.js';
import { ILucosAuthService } from '../common/lucosAuthService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosWorkspaceContext, IStartAgentTaskRequest, LucosConnectionState, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';
import { LucosActivityTimeline } from './lucosActivityTimeline.js';
import { ILucosContextMention, LucosContextPicker } from './lucosContextPicker.js';
import { LucosPatchReview } from './lucosPatchReview.js';

export class LucosChatViewPane extends ViewPane {

	static readonly ID = 'lucos.chatView';

	private bannerContainer!: HTMLElement;
	private bannerText!: HTMLElement;
	private bannerAction!: HTMLAnchorElement;
	private bannerActionHandler: (() => void) | undefined;

	private timeline!: LucosActivityTimeline;

	private chipsContainer!: HTMLElement;
	private contextPicker!: LucosContextPicker;
	private patchReview!: LucosPatchReview;
	private readonly mentions: ILucosContextMention[] = [];

	private messagesContainer!: HTMLElement;
	private inputBox!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;

	private readonly messageElements = new Map<string, HTMLElement>();
	private readonly pendingUpdates = new Map<string, ILucosMessage>();
	private scheduledFlush: IDisposable | undefined;
	private activeStream: CancellationTokenSource | undefined;

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
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
		@ILucosConversationService private readonly conversationService: ILucosConversationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosAuthService private readonly lucosAuthService: ILucosAuthService,
		@ILucosChatRequestService private readonly chatRequestService: ILucosChatRequestService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.conversationService.onDidAddMessage(e => this.renderMessage(e.message)));
		this._register(this.conversationService.onDidUpdateMessage(e => this.updateMessage(e.message)));
		this._register(this.chatRequestService.onDidRequest(request => this.handleExternalRequest(request)));
		this._register(toDisposable(() => this.scheduledFlush?.dispose()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('lucos-chat');
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.height = '100%';

		// Banner (TW-172) — connection/auth states.
		this.bannerContainer = dom.append(container, dom.$('.lucos-chat-banner'));
		this.bannerContainer.style.display = 'none';
		this.bannerContainer.style.padding = '6px 8px';
		this.bannerContainer.style.background = 'var(--vscode-inputValidation-warningBackground)';
		this.bannerContainer.style.color = 'var(--vscode-inputValidation-warningForeground)';
		this.bannerText = dom.append(this.bannerContainer, dom.$('span.lucos-banner-text'));
		this.bannerAction = dom.append(this.bannerContainer, dom.$('a.lucos-banner-action')) as HTMLAnchorElement;
		this.bannerAction.style.marginLeft = '8px';
		this.bannerAction.style.cursor = 'pointer';
		this.bannerAction.style.textDecoration = 'underline';
		this._register(dom.addDisposableListener(this.bannerAction, 'click', () => this.bannerActionHandler?.()));

		// Activity timeline (TW-162).
		this.timeline = this._register(new LucosActivityTimeline(container));
		this.contextPicker = this.instantiationService.createInstance(LucosContextPicker);
		this.patchReview = this._register(this.instantiationService.createInstance(LucosPatchReview));

		// Messages.
		this.messagesContainer = dom.append(container, dom.$('.lucos-chat-messages'));
		this.messagesContainer.style.flex = '1';
		this.messagesContainer.style.overflowY = 'auto';
		this.messagesContainer.style.padding = '8px';

		// Attached-context chips (TW-164).
		this.chipsContainer = dom.append(container, dom.$('.lucos-chat-chips'));
		this.chipsContainer.style.display = 'flex';
		this.chipsContainer.style.flexWrap = 'wrap';
		this.chipsContainer.style.gap = '4px';
		this.chipsContainer.style.padding = '0 8px';

		// Composer.
		const inputRow = dom.append(container, dom.$('.lucos-chat-input'));
		inputRow.style.display = 'flex';
		inputRow.style.gap = '4px';
		inputRow.style.padding = '8px';

		const addContextButton = dom.append(inputRow, dom.$('button.lucos-chat-context')) as HTMLButtonElement;
		addContextButton.textContent = '@';
		addContextButton.title = localize('lucos.chat.addContext', "Attach context");
		this._register(dom.addDisposableListener(addContextButton, 'click', () => this.addContext()));

		this.inputBox = dom.append(inputRow, dom.$('textarea.lucos-chat-textarea')) as HTMLTextAreaElement;
		this.inputBox.placeholder = localize('lucos.chat.inputPlaceholder', "Ask Lucos… (Enter to send, Shift+Enter for newline)");
		this.inputBox.rows = 2;
		this.inputBox.style.flex = '1';
		this.inputBox.style.resize = 'none';

		this.sendButton = dom.append(inputRow, dom.$('button.lucos-chat-send')) as HTMLButtonElement;
		this.sendButton.textContent = localize('lucos.chat.send', "Send");

		this._register(dom.addDisposableListener(this.inputBox, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				this.onSend();
			}
		}));
		this._register(dom.addDisposableListener(this.sendButton, 'click', () => this.onSend()));

		this._register(this.lucosDaemonService.onDidChangeConnectionState(() => this.updateConnectionBanner()));
		this.updateConnectionBanner();

		for (const message of this.conversationService.activeSession.messages) {
			this.renderMessage(message);
		}
	}

	private onSend(): void {
		// While a response is streaming the button acts as Stop.
		if (this.activeStream) {
			this.activeStream.cancel();
			return;
		}

		const text = this.inputBox.value.trim();
		if (!text) {
			return;
		}
		this.inputBox.value = '';
		void this.runTask(text);
	}

	private async runTask(goal: string, contextOverride?: ILucosWorkspaceContext, selectedAgentPath?: string): Promise<void> {
		this.timeline.clear();
		this.conversationService.addMessage(LucosMessageRole.User, goal);
		const assistant = this.conversationService.addMessage(LucosMessageRole.Assistant, '', true);

		const cts = new CancellationTokenSource();
		this.activeStream = cts;
		this.setStreaming(true);

		// Always attach the workspace root so the daemon's file tools resolve paths (TW-161/220).
		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		const request: IStartAgentTaskRequest = { goal, sessionId: this.conversationService.activeSession.id, context: { ...(contextOverride ?? this.buildContext()), workspaceRoot }, selectedAgentPath };
		if (!contextOverride) {
			this.clearContext();
		}

		try {
			for await (const event of this.lucosDaemonService.startAgentTask(request, cts.token)) {
				this.timeline.handleEvent(event);
				switch (event.kind) {
					case LucosTaskEventKind.ModelDelta: {
						const delta = (event.payload as { textDelta?: string }).textDelta ?? '';
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
							void this.showPatch(patchId);
						}
						break;
					}
					case LucosTaskEventKind.TaskCompleted:
					case LucosTaskEventKind.Error:
						break;
					// tool.started / patch.proposed are consumed by the timeline (TW-162) and diff (TW-165).
				}
			}
		} catch (error) {
			this.conversationService.appendToMessage(assistant.id, `\n\n[error] ${error}`);
		} finally {
			this.conversationService.completeMessage(assistant.id);
			this.activeStream = undefined;
			this.setStreaming(false);
		}
	}

	private promptSignIn(): void {
		this.notificationService.prompt(
			Severity.Warning,
			localize('lucos.auth.required', "Sign in to use Lucos AI."),
			[{ label: localize('lucos.auth.signIn', "Sign In"), run: () => { void this.lucosAuthService.login(); } }],
		);
	}

	private async addContext(): Promise<void> {
		const mention = await this.contextPicker.pick();
		if (!mention) {
			return;
		}
		this.mentions.push(mention);
		const chip = dom.append(this.chipsContainer, dom.$('span.lucos-chat-chip'));
		chip.textContent = mention.label;
		chip.style.padding = '1px 6px';
		chip.style.borderRadius = '3px';
		chip.style.background = 'var(--vscode-badge-background)';
		chip.style.color = 'var(--vscode-badge-foreground)';
		chip.style.fontSize = '0.85em';
	}

	private clearContext(): void {
		this.mentions.length = 0;
		dom.clearNode(this.chipsContainer);
	}

	private buildContext(): ILucosWorkspaceContext | undefined {
		if (!this.mentions.length) {
			return undefined;
		}
		return {
			selection: this.mentions.find(m => m.type === 'selection')?.text,
			activeFile: this.mentions.find(m => m.type === 'file' || m.type === 'selection')?.path,
			workspaceId: this.mentions.find(m => m.type === 'workspace')?.workspaceId,
			openBuffers: this.mentions.filter(m => m.type === 'file' && m.path).map(m => m.path!),
		};
	}

	private handleExternalRequest(request: ILucosChatRequest): void {
		if (this.activeStream) {
			return;
		}
		void this.runTask(request.goal, request.context, request.selectedAgentPath);
	}

	private async showPatch(patchId: string): Promise<void> {
		const patch = await this.lucosDaemonService.getPendingPatch(patchId);
		if (patch) {
			this.patchReview.render(this.messagesContainer, patch);
			this.scrollToBottom();
		}
	}

	private setStreaming(streaming: boolean): void {
		this.sendButton.textContent = streaming
			? localize('lucos.chat.stop', "Stop")
			: localize('lucos.chat.send', "Send");
		this.inputBox.disabled = streaming;
	}

	private updateConnectionBanner(): void {
		if (this.lucosDaemonService.connectionState === LucosConnectionState.Disconnected) {
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
				this.updateConnectionBanner();
			}
		} catch {
			// Still offline — leave the banner up.
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
		this.bannerContainer.style.display = 'block';
	}

	private hideBanner(): void {
		this.bannerContainer.style.display = 'none';
		this.bannerActionHandler = undefined;
	}

	private renderMessage(message: ILucosMessage): void {
		const el = dom.append(this.messagesContainer, dom.$(`.lucos-chat-message.lucos-role-${message.role}`));
		el.style.margin = '4px 0';
		el.style.whiteSpace = 'pre-wrap';
		el.style.wordBreak = 'break-word';
		el.style.opacity = message.role === LucosMessageRole.User ? '1' : '0.9';
		el.textContent = message.content;
		this.messageElements.set(message.id, el);
		this.scrollToBottom();
	}

	private updateMessage(message: ILucosMessage): void {
		// TW-173: coalesce streaming DOM writes to one flush per animation frame to avoid jank.
		this.pendingUpdates.set(message.id, message);
		if (!this.scheduledFlush) {
			this.scheduledFlush = dom.scheduleAtNextAnimationFrame(dom.getWindow(this.messagesContainer), () => this.flushUpdates());
		}
	}

	private flushUpdates(): void {
		this.scheduledFlush = undefined;
		for (const [id, message] of this.pendingUpdates) {
			const el = this.messageElements.get(id);
			if (el) {
				el.textContent = message.content;
			}
		}
		this.pendingUpdates.clear();
		this.scrollToBottom();
	}

	private scrollToBottom(): void {
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}
}
