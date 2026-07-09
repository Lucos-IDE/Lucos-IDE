/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — editor & command-palette AI actions (TW-163 Cmd+K, TW-167 palette, TW-184 picker).
 *  Each action captures editor context and hands a goal to the chat view via
 *  ILucosChatRequestService; the existing streaming + patch-review flow handles the result.
 *
 *  IMPORTANT: the ServicesAccessor is only valid during the SYNCHRONOUS part of run(). All
 *  services must be resolved up front (before any await) and used as instances thereafter.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ILucosWorkspaceContext } from '../../../../platform/lucos/common/lucosProtocol.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ILucosChatRequestService } from '../common/lucosChatRequestService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { LUCOS_CHAT_VIEW_ID } from './lucosCommands.js';

const LUCOS_CATEGORY = localize2('lucos', "Lucos");

function captureSelectionContext(editorService: IEditorService): ILucosWorkspaceContext | undefined {
	const editor = editorService.activeTextEditorControl;
	if (isCodeEditor(editor)) {
		const model = editor.getModel();
		const selection = editor.getSelection();
		if (model && selection && !selection.isEmpty()) {
			return { selection: model.getValueInRange(selection), activeFile: model.uri.fsPath };
		}
		if (model) {
			return { activeFile: model.uri.fsPath };
		}
	}
	return undefined;
}

async function submitToChat(viewsService: IViewsService, chatRequestService: ILucosChatRequestService, goal: string, context: ILucosWorkspaceContext | undefined, selectedAgentPath?: string): Promise<void> {
	await viewsService.openView(LUCOS_CHAT_VIEW_ID, true);
	chatRequestService.submit({ goal, context, selectedAgentPath });
}

export class LucosCmdKAction extends Action2 {
	static readonly ID = 'lucos.cmdK';
	constructor() {
		super({
			id: LucosCmdKAction.ID,
			title: localize2('lucos.cmdK.title', "Edit with Lucos"),
			category: LUCOS_CATEGORY,
			f1: true,
			precondition: EditorContextKeys.writable,
			keybinding: {
				weight: KeybindingWeight.EditorContrib,
				when: EditorContextKeys.editorTextFocus,
				// TODO(TW-163): Ctrl/Cmd+K is a chord prefix in VS Code — confirm it doesn't clash,
				// or move to a dedicated inline widget with its own key handling.
				primary: KeyMod.CtrlCmd | KeyCode.KeyK,
			},
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const quickInputService = accessor.get(IQuickInputService);
		const viewsService = accessor.get(IViewsService);
		const chatRequestService = accessor.get(ILucosChatRequestService);

		const context = captureSelectionContext(editorService);
		const instruction = await quickInputService.input({
			prompt: localize('lucos.cmdK.prompt', "Describe the edit for Lucos to make"),
			placeHolder: localize('lucos.cmdK.placeholder', "e.g. add error handling"),
			ignoreFocusLost: true,
		});
		if (!instruction) {
			return;
		}
		await submitToChat(viewsService, chatRequestService, instruction, context);
	}
}

export class LucosExplainAction extends Action2 {
	static readonly ID = 'lucos.explain';
	constructor() {
		super({ id: LucosExplainAction.ID, title: localize2('lucos.explain.title', "AI: Explain Selection"), category: LUCOS_CATEGORY, f1: true, precondition: EditorContextKeys.hasNonEmptySelection });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return submitToChat(accessor.get(IViewsService), accessor.get(ILucosChatRequestService), localize('lucos.explain.goal', "Explain this code."), captureSelectionContext(accessor.get(IEditorService)));
	}
}

export class LucosRefactorAction extends Action2 {
	static readonly ID = 'lucos.refactor';
	constructor() {
		super({ id: LucosRefactorAction.ID, title: localize2('lucos.refactor.title', "AI: Refactor Selection"), category: LUCOS_CATEGORY, f1: true, precondition: EditorContextKeys.writable });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const quickInputService = accessor.get(IQuickInputService);
		const viewsService = accessor.get(IViewsService);
		const chatRequestService = accessor.get(ILucosChatRequestService);

		const context = captureSelectionContext(editorService);
		const instruction = await quickInputService.input({ prompt: localize('lucos.refactor.prompt', "How should Lucos refactor this?"), ignoreFocusLost: true });
		if (!instruction) {
			return;
		}
		await submitToChat(viewsService, chatRequestService, localize('lucos.refactor.goal', "Refactor this code: {0}", instruction), context);
	}
}

export class LucosGenerateTestsAction extends Action2 {
	static readonly ID = 'lucos.generateTests';
	constructor() {
		super({ id: LucosGenerateTestsAction.ID, title: localize2('lucos.generateTests.title', "AI: Generate Tests"), category: LUCOS_CATEGORY, f1: true, precondition: EditorContextKeys.writable });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return submitToChat(accessor.get(IViewsService), accessor.get(ILucosChatRequestService), localize('lucos.generateTests.goal', "Generate unit tests for this code."), captureSelectionContext(accessor.get(IEditorService)));
	}
}

export class LucosReviewChangesAction extends Action2 {
	static readonly ID = 'lucos.reviewChanges';
	constructor() {
		super({ id: LucosReviewChangesAction.ID, title: localize2('lucos.reviewChanges.title', "AI: Review Changes"), category: LUCOS_CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return submitToChat(accessor.get(IViewsService), accessor.get(ILucosChatRequestService), localize('lucos.reviewChanges.goal', "Review my current git changes and flag issues."), undefined);
	}
}

interface ICustomizationPickItem extends IQuickPickItem {
	readonly path: string;
}

export class LucosSelectCustomizationAction extends Action2 {
	static readonly ID = 'lucos.selectCustomization';
	constructor() {
		super({ id: LucosSelectCustomizationAction.ID, title: localize2('lucos.customization.title', "AI: Run Skill or Agent"), category: LUCOS_CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const daemonService = accessor.get(ILucosDaemonService);
		const notificationService = accessor.get(INotificationService);
		const quickInputService = accessor.get(IQuickInputService);
		const viewsService = accessor.get(IViewsService);
		const chatRequestService = accessor.get(ILucosChatRequestService);
		const editorService = accessor.get(IEditorService);

		const workspaceRoot = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		const customizations = await daemonService.listCustomizations(workspaceRoot);
		const items: ICustomizationPickItem[] = [
			...customizations.agents.map(agent => ({ label: `$(person) ${agent.displayName}`, description: agent.description, path: agent.path })),
			...customizations.skills.map(skill => ({ label: `$(sparkle) ${skill.name}`, description: skill.description, path: skill.path })),
		];
		if (!items.length) {
			notificationService.notify({ severity: Severity.Info, message: localize('lucos.customization.none', "No Lucos skills or agents found in this workspace.") });
			return;
		}
		const choice = await quickInputService.pick(items, { placeHolder: localize('lucos.customization.pick', "Select a skill or agent to run") });
		if (!choice) {
			return;
		}
		const instruction = await quickInputService.input({ prompt: localize('lucos.customization.prompt', "What should it do?"), ignoreFocusLost: true });
		if (!instruction) {
			return;
		}
		await submitToChat(viewsService, chatRequestService, instruction, captureSelectionContext(editorService), choice.path);
	}
}
