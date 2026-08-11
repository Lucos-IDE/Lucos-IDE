/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILucosFileChangeStat } from '../common/lucosFileChangeStats.js';

export interface ILucosFollowup {
	readonly label: string;
	readonly prompt: string;
}

/**
 * Build a small set of suggested follow-up prompts after a turn completes.
 */
export function suggestLucosFollowups(goal: string, files: readonly ILucosFileChangeStat[]): ILucosFollowup[] {
	const suggestions: ILucosFollowup[] = [];
	const primary = files[0]?.path;
	const basename = primary ? primary.split(/[/\\]/).pop() : undefined;

	if (files.length > 0) {
		suggestions.push({
			label: localize('lucos.followup.explain', "Explain the changes"),
			prompt: localize(
				'lucos.followup.explainPrompt',
				"Explain the changes you just made{0}.",
				basename ? ` in ${basename}` : '',
			),
		});
		suggestions.push({
			label: localize('lucos.followup.tests', "Add tests"),
			prompt: localize(
				'lucos.followup.testsPrompt',
				"Add tests covering the recent changes{0}.",
				basename ? ` in ${basename}` : '',
			),
		});
		suggestions.push({
			label: localize('lucos.followup.review', "Review for bugs"),
			prompt: localize('lucos.followup.reviewPrompt', "Review the recent changes for bugs and edge cases."),
		});
	} else {
		suggestions.push({
			label: localize('lucos.followup.elaborate', "Go deeper"),
			prompt: localize('lucos.followup.elaboratePrompt', "Go deeper on that answer with more detail."),
		});
		suggestions.push({
			label: localize('lucos.followup.examples', "Show an example"),
			prompt: localize('lucos.followup.examplesPrompt', "Show a concrete example based on that answer."),
		});
	}

	const lowered = goal.toLowerCase();
	if (/\b(create|add|implement)\b/.test(lowered) && files.length > 0) {
		suggestions.push({
			label: localize('lucos.followup.docs', "Document it"),
			prompt: localize('lucos.followup.docsPrompt', "Add brief documentation for the change you just made."),
		});
	}

	// Cap to keep the composer area tidy.
	return suggestions.slice(0, 3);
}

export class LucosFollowups extends Disposable {

	private readonly renderDisposables = this._register(new DisposableStore());

	render(container: HTMLElement, followups: readonly ILucosFollowup[], onSelect: (followup: ILucosFollowup) => void): void {
		this.renderDisposables.clear();
		dom.clearNode(container);
		if (!followups.length) {
			container.classList.remove('visible');
			return;
		}
		container.classList.add('visible');
		const row = dom.append(container, dom.$('.lucos-followups-row'));
		for (const followup of followups) {
			const chip = dom.append(row, dom.$('button.lucos-followup-chip')) as HTMLButtonElement;
			chip.textContent = followup.label;
			chip.title = followup.prompt;
			this.renderDisposables.add(dom.addDisposableListener(chip, 'click', () => onSelect(followup)));
		}
	}

	clear(container: HTMLElement): void {
		this.renderDisposables.clear();
		dom.clearNode(container);
		container.classList.remove('visible');
	}
}
