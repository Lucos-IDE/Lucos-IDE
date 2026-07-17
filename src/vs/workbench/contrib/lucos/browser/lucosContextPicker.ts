/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { ISearchService } from '../../../services/search/common/search.js';

export type LucosContextMentionType = 'selection' | 'file' | 'workspace';

export interface ILucosContextMention {
	readonly type: LucosContextMentionType;
	readonly label: string;
	readonly path?: string;
	readonly text?: string;
	readonly workspaceId?: string;
	/** Relative directory path shown as secondary text in the mention menu. */
	readonly description?: string;
}

export type LucosStaticContextKind = 'selection' | 'activeFile' | 'workspace';

export interface ILucosStaticContextOption {
	readonly kind: LucosStaticContextKind;
	readonly label: string;
	readonly description: string;
}

const MAX_FILE_RESULTS = 20;

export class LucosContextPicker {

	private readonly fileQueryBuilder: QueryBuilder;

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ISearchService private readonly searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		this.fileQueryBuilder = instantiationService.createInstance(QueryBuilder);
	}

	getStaticOptions(query: string = ''): readonly ILucosStaticContextOption[] {
		const q = query.trim().toLowerCase();
		const options: ILucosStaticContextOption[] = [
			{
				kind: 'selection',
				label: localize('lucos.context.selection', "Selection"),
				description: localize('lucos.context.selectionDesc', "The current editor selection"),
			},
			{
				kind: 'activeFile',
				label: localize('lucos.context.activeFile', "Active file"),
				description: localize('lucos.context.fileDesc', "The file open in the active editor"),
			},
			{
				kind: 'workspace',
				label: localize('lucos.context.workspace', "Workspace"),
				description: localize('lucos.context.workspaceDesc', "The current workspace"),
			},
		];
		if (!q) {
			return options;
		}
		return options.filter(o =>
			o.label.toLowerCase().includes(q)
			|| o.kind.toLowerCase().includes(q)
			|| o.description.toLowerCase().includes(q)
		);
	}

	captureStatic(kind: LucosStaticContextKind): ILucosContextMention | undefined {
		switch (kind) {
			case 'selection': return this.captureSelection();
			case 'activeFile': return this.captureActiveFile();
			case 'workspace': return this.captureWorkspace();
		}
	}

	mentionForResource(resource: URI): ILucosContextMention {
		const name = basename(resource);
		const parent = dirname(resource);
		const folder = this.workspaceContextService.getWorkspaceFolder(resource);
		let description: string | undefined;
		if (folder) {
			const relative = resource.path.slice(folder.uri.path.length).replace(/^\//, '');
			const slash = relative.lastIndexOf('/');
			description = slash >= 0 ? relative.slice(0, slash) : undefined;
		} else {
			description = basename(parent);
		}
		return {
			type: 'file',
			label: `@${name}`,
			path: resource.fsPath,
			description,
		};
	}

	async searchFiles(query: string, token: CancellationToken): Promise<ILucosContextMention[]> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (!folders.length) {
			return [];
		}
		const fileQuery = this.fileQueryBuilder.file(folders, {
			filePattern: query,
			sortByScore: true,
			maxResults: MAX_FILE_RESULTS,
			_reason: 'lucosContextMention',
		});
		const result = await this.searchService.fileSearch(fileQuery, token);
		if (token.isCancellationRequested) {
			return [];
		}
		return result.results.map(r => this.mentionForResource(r.resource));
	}

	captureSelection(): ILucosContextMention | undefined {
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

	captureActiveFile(): ILucosContextMention | undefined {
		const editor = this.editorService.activeTextEditorControl;
		if (isCodeEditor(editor)) {
			const model = editor.getModel();
			if (model) {
				return this.mentionForResource(model.uri);
			}
		}
		return undefined;
	}

	captureWorkspace(): ILucosContextMention | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return { type: 'workspace', label: '@workspace', workspaceId: folder.uri.toString(), path: folder.uri.fsPath };
	}
}
