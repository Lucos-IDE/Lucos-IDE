/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

/** In-memory contents for `lucos-patch://` review URIs. */
const lucosPatchContents = new Map<string, string>();

export function setLucosPatchContent(resource: URI, content: string): void {
	lucosPatchContents.set(resource.toString(true), content);
}

export function clearLucosPatchContent(resource: URI): void {
	lucosPatchContents.delete(resource.toString(true));
}

export function makeLucosPatchUri(path: string, side: 'original' | 'modified'): URI {
	// Prefer a rooted path so language detection from filepath works.
	const normalized = path.startsWith('/') ? path : `/${path}`;
	return URI.from({
		scheme: Schemas.lucosPatch,
		path: normalized,
		query: `side=${side}`,
	});
}

class LucosPatchContentProvider extends Disposable implements ITextModelContentProvider, IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.lucosPatchContentProvider';

	constructor(
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(Schemas.lucosPatch, this));
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing && !existing.isDisposed()) {
			const next = lucosPatchContents.get(resource.toString(true));
			if (typeof next === 'string' && existing.getValue() !== next) {
				existing.setValue(next);
			}
			return existing;
		}

		const content = lucosPatchContents.get(resource.toString(true));
		if (typeof content !== 'string') {
			return null;
		}

		const languageSelection = this.languageService.createByFilepathOrFirstLine(resource);
		return this.modelService.createModel(content, languageSelection, resource);
	}
}

registerWorkbenchContribution2(LucosPatchContentProvider.ID, LucosPatchContentProvider, WorkbenchPhase.BlockRestore);
