/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILucosFileChange, ILucosPatchProposal } from '../../../../platform/lucos/common/lucosProtocol.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

export class LucosPatchReview extends Disposable {

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();
	}

	render(container: HTMLElement, patch: ILucosPatchProposal, onResolved?: () => void): void {
		dom.clearNode(container);
		container.style.display = 'block';

		const card = dom.append(container, dom.$('.lucos-patch-card'));
		card.style.margin = '8px 0';
		card.style.padding = '8px';
		card.style.border = '1px solid var(--vscode-panel-border)';
		card.style.borderRadius = '4px';

		const title = dom.append(card, dom.$('.lucos-patch-title'));
		title.textContent = patch.summary || localize('lucos.patch.proposed', "Proposed changes");
		title.style.fontWeight = '600';
		title.style.marginBottom = '4px';

		for (const change of patch.fileChanges) {
			const link = dom.append(card, dom.$('a.lucos-patch-file')) as HTMLAnchorElement;
			link.textContent = change.path;
			link.style.display = 'block';
			link.style.cursor = 'pointer';
			link.style.textDecoration = 'underline';
			this._register(dom.addDisposableListener(link, 'click', () => void this.openDiff(change)));
		}

		const actions = dom.append(card, dom.$('.lucos-patch-actions'));
		actions.style.marginTop = '6px';
		actions.style.display = 'flex';
		actions.style.gap = '6px';

		const acceptButton = dom.append(actions, dom.$('button.lucos-patch-accept')) as HTMLButtonElement;
		acceptButton.textContent = localize('lucos.patch.accept', "Accept");
		const rejectButton = dom.append(actions, dom.$('button.lucos-patch-reject')) as HTMLButtonElement;
		rejectButton.textContent = localize('lucos.patch.reject', "Reject");

		const status = dom.append(card, dom.$('.lucos-patch-status'));
		status.style.marginTop = '4px';
		status.style.opacity = '0.8';

		this._register(dom.addDisposableListener(acceptButton, 'click', () => void this.accept(patch, actions, status, onResolved)));
		this._register(dom.addDisposableListener(rejectButton, 'click', () => void this.reject(patch, actions, status, onResolved)));
	}

	private async openDiff(change: ILucosFileChange): Promise<void> {
		const original = URI.from({ scheme: 'lucos-patch', path: change.path, query: 'side=original' });
		const modified = URI.from({ scheme: 'lucos-patch', path: change.path, query: 'side=modified' });
		await this.editorService.openEditor({
			original: { resource: original, contents: change.oldText },
			modified: { resource: modified, contents: change.newText },
			label: localize('lucos.patch.diffLabel', "Lucos Review: {0}", change.path),
			options: { pinned: true },
		});
	}

	private async accept(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, onResolved?: () => void): Promise<void> {
		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		try {
			const result = await this.lucosDaemonService.applyPatch(patch.patchId, workspaceRoot);
			actions.style.display = 'none';
			status.textContent = localize('lucos.patch.applied', "Applied - {0} file(s) changed.", result.filesChanged.length);
			onResolved?.();
		} catch (error) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.applyFailed', "Failed to apply patch: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	private async reject(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, onResolved?: () => void): Promise<void> {
		try {
			await this.lucosDaemonService.rejectPatch(patch.patchId);
			actions.style.display = 'none';
			status.textContent = localize('lucos.patch.rejected', "Rejected.");
			onResolved?.();
		} catch (error) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.rejectFailed', "Failed to reject patch: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}
}
