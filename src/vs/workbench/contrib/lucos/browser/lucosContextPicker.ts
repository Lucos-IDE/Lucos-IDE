/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — workspace context picker (TW-164).
 *  Captures @selection / @file / @workspace as structured context that threads into the
 *  StartAgentTaskRequest. Only paths/selection text cross the wire — the daemon reads file
 *  contents locally (it owns the workspace), so nothing large is uploaded from here.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export type LucosContextMentionType = 'selection' | 'file' | 'workspace';

export interface ILucosContextMention {
	readonly type: LucosContextMentionType;
	readonly label: string;
	readonly path?: string;
	readonly text?: string;
	readonly workspaceId?: string;
}

interface IContextQuickPickItem extends IQuickPickItem {
	readonly kind: LucosContextMentionType;
}

export class LucosContextPicker {

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) { }

	async pick(): Promise<ILucosContextMention | undefined> {
		const items: IContextQuickPickItem[] = [
			{ kind: 'selection', label: '$(selection) Selection', description: localize('lucos.context.selectionDesc', "The current editor selection") },
			{ kind: 'file', label: '$(file) Active file', description: localize('lucos.context.fileDesc', "The file open in the active editor") },
			{ kind: 'workspace', label: '$(folder) Workspace', description: localize('lucos.context.workspaceDesc', "The current workspace") },
		];
		const choice = await this.quickInputService.pick(items, { placeHolder: localize('lucos.context.placeholder', "Attach context to your prompt") });
		if (!choice) {
			return undefined;
		}
		switch (choice.kind) {
			case 'selection': return this.captureSelection();
			case 'file': return this.captureActiveFile();
			case 'workspace': return this.captureWorkspace();
		}
	}

	private captureSelection(): ILucosContextMention | undefined {
		const editor = this.editorService.activeTextEditorControl;
		if (isCodeEditor(editor)) {
			const selection = editor.getSelection();
			const model = editor.getModel();
			if (selection && model && !selection.isEmpty()) {
				return { type: 'selection', label: '@selection', text: model.getValueInRange(selection), path: model.uri.fsPath };
			}
		}
		return undefined;
	}

	private captureActiveFile(): ILucosContextMention | undefined {
		const editor = this.editorService.activeTextEditorControl;
		if (isCodeEditor(editor)) {
			const model = editor.getModel();
			if (model) {
				return { type: 'file', label: `@${basename(model.uri)}`, path: model.uri.fsPath };
			}
		}
		return undefined;
	}

	private captureWorkspace(): ILucosContextMention | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return { type: 'workspace', label: '@workspace', workspaceId: folder.uri.toString(), path: folder.uri.fsPath };
	}
}
