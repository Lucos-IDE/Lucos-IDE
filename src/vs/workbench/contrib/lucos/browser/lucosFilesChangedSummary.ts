/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILucosFileChangeStat } from '../common/lucosFileChangeStats.js';

export interface ILucosFilesChangedSummaryCallbacks {
	readonly onOpenFile?: (path: string) => void;
	readonly onReview?: () => void;
}

function displayName(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] || path;
}

/**
 * Cursor-like post-turn "N Files Changed" card with +/- line counts.
 */
export class LucosFilesChangedSummary extends Disposable {

	private readonly renderDisposables = this._register(new DisposableStore());

	render(container: HTMLElement, files: readonly ILucosFileChangeStat[], callbacks: ILucosFilesChangedSummaryCallbacks = {}): void {
		this.renderDisposables.clear();
		dom.clearNode(container);
		if (!files.length) {
			container.classList.remove('visible');
			return;
		}

		container.classList.add('visible');
		const card = dom.append(container, dom.$('.lucos-files-changed-card'));

		const header = dom.append(card, dom.$('.lucos-files-changed-header'));
		const label = dom.append(header, dom.$('span.lucos-files-changed-label'));
		label.textContent = files.length === 1
			? localize('lucos.filesChanged.one', "1 File Changed")
			: localize('lucos.filesChanged.many', "{0} Files Changed", files.length);

		const review = dom.append(header, dom.$('button.lucos-files-changed-review')) as HTMLButtonElement;
		review.textContent = localize('lucos.filesChanged.review', "Review");
		review.title = localize('lucos.filesChanged.reviewTitle', "Review changed files");
		this.renderDisposables.add(dom.addDisposableListener(review, 'click', () => {
			if (callbacks.onReview) {
				callbacks.onReview();
			} else if (files[0]) {
				callbacks.onOpenFile?.(files[0].path);
			}
		}));

		const list = dom.append(card, dom.$('.lucos-files-changed-list'));
		for (const file of files) {
			const row = dom.append(list, dom.$('button.lucos-files-changed-row')) as HTMLButtonElement;
			row.title = file.path;

			const name = dom.append(row, dom.$('span.lucos-files-changed-path'));
			name.textContent = displayName(file.path);

			const counts = dom.append(row, dom.$('span.lucos-files-changed-counts'));
			if (file.added > 0) {
				const added = dom.append(counts, dom.$('span.insertions'));
				added.textContent = `+${file.added}`;
			}
			if (file.removed > 0) {
				const removed = dom.append(counts, dom.$('span.deletions'));
				removed.textContent = `-${file.removed}`;
			}
			if (file.added === 0 && file.removed === 0) {
				const none = dom.append(counts, dom.$('span.lucos-files-changed-none'));
				none.textContent = localize('lucos.filesChanged.unchangedLines', "·");
			}

			this.renderDisposables.add(dom.addDisposableListener(row, 'click', () => callbacks.onOpenFile?.(file.path)));
		}
	}

	clear(container: HTMLElement): void {
		this.renderDisposables.clear();
		dom.clearNode(container);
		container.classList.remove('visible');
	}
}
