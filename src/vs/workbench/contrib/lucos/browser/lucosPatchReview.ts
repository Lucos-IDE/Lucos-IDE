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

export interface ILucosPatchReviewCallbacks {
	/** Called when Accept/Reject/Undo finishes and the card should leave session chrome. */
	readonly onResolved?: () => void;
	/** Called after a successful Accept so the host can keep Undo available on this turn. */
	readonly onApplied?: (patch: ILucosPatchProposal) => void;
	/** Called after a successful Undo. */
	readonly onReverted?: (patch: ILucosPatchProposal) => void;
}

export class LucosPatchReview extends Disposable {

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();
	}

	render(container: HTMLElement, patch: ILucosPatchProposal, callbacks: ILucosPatchReviewCallbacks = {}): void {
		dom.clearNode(container);
		container.classList.add('visible');

		const card = dom.append(container, dom.$('.lucos-patch-card'));

		const title = dom.append(card, dom.$('.lucos-patch-title'));
		title.textContent = patch.summary || localize('lucos.patch.proposed', "Proposed changes");

		for (const change of patch.fileChanges) {
			if (this.isNewFileChange(change)) {
				const row = dom.append(card, dom.$('.lucos-patch-file.lucos-patch-file-new'));
				row.textContent = localize(
					'lucos.patch.newFileLabel',
					"{0} (new — preview after Accept)",
					change.path,
				);
				row.title = localize(
					'lucos.patch.newFileHint',
					"This file does not exist yet. Accept the patch to create it, then open it from the explorer.",
				);
				continue;
			}

			const link = dom.append(card, dom.$('a.lucos-patch-file')) as HTMLAnchorElement;
			link.textContent = change.path;
			this._register(dom.addDisposableListener(link, 'click', () => void this.openDiff(change)));
		}

		const actions = dom.append(card, dom.$('.lucos-patch-actions'));
		const status = dom.append(card, dom.$('.lucos-patch-status'));
		status.style.marginTop = '4px';
		status.style.opacity = '0.8';

		if (patch.status === 'applied') {
			this.renderUndoActions(patch, actions, status, callbacks);
			status.textContent = localize('lucos.patch.appliedReady', "Applied — you can undo these changes.");
			return;
		}

		if (patch.status === 'reverted') {
			actions.style.display = 'none';
			status.textContent = localize('lucos.patch.reverted', "Reverted.");
			return;
		}

		const acceptButton = dom.append(actions, dom.$('button.lucos-patch-accept')) as HTMLButtonElement;
		acceptButton.textContent = localize('lucos.patch.accept', "Accept");
		const rejectButton = dom.append(actions, dom.$('button.lucos-patch-reject')) as HTMLButtonElement;
		rejectButton.textContent = localize('lucos.patch.reject', "Reject");

		this._register(dom.addDisposableListener(acceptButton, 'click', () => void this.accept(patch, actions, status, callbacks)));
		this._register(dom.addDisposableListener(rejectButton, 'click', () => void this.reject(patch, actions, status, callbacks)));
	}

	private renderUndoActions(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, callbacks: ILucosPatchReviewCallbacks): void {
		dom.clearNode(actions);
		actions.style.display = '';
		const undoButton = dom.append(actions, dom.$('button.lucos-patch-undo')) as HTMLButtonElement;
		undoButton.textContent = localize('lucos.patch.undo', "Undo");
		this._register(dom.addDisposableListener(undoButton, 'click', () => void this.undo(patch, actions, status, callbacks)));
	}

	private isNewFileChange(change: ILucosFileChange): boolean {
		// Matches daemon create semantics: empty old_text + non-empty new_text.
		return !change.oldText && !!change.newText;
	}

	private async openDiff(change: ILucosFileChange): Promise<void> {
		if (this.isNewFileChange(change)) {
			this.notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'lucos.patch.newFilePreviewBlocked',
					"Preview is unavailable until the file is created. Accept the patch first.",
				),
			});
			return;
		}

		const original = URI.from({ scheme: 'lucos-patch', path: change.path, query: 'side=original' });
		const modified = URI.from({ scheme: 'lucos-patch', path: change.path, query: 'side=modified' });
		try {
			await this.editorService.openEditor({
				original: { resource: original, contents: change.oldText },
				modified: { resource: modified, contents: change.newText },
				label: localize('lucos.patch.diffLabel', "Lucos Review: {0}", change.path),
				options: { pinned: true },
			});
		} catch (error) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize(
					'lucos.patch.diffOpenFailed',
					"Failed to open patch preview for {0}: {1}",
					change.path,
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	}

	private async accept(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, callbacks: ILucosPatchReviewCallbacks): Promise<void> {
		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		try {
			const result = await this.lucosDaemonService.applyPatch(patch.patchId, workspaceRoot);
			const applied: ILucosPatchProposal = { ...patch, status: 'applied' };
			status.textContent = localize('lucos.patch.applied', "Applied — {0} file(s) changed.", result.filesChanged.length);
			this.renderUndoActions(applied, actions, status, callbacks);
			callbacks.onApplied?.(applied);
		} catch (error) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.applyFailed', "Failed to apply patch: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	private async reject(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, callbacks: ILucosPatchReviewCallbacks): Promise<void> {
		try {
			await this.lucosDaemonService.rejectPatch(patch.patchId);
			actions.style.display = 'none';
			status.textContent = localize('lucos.patch.rejected', "Rejected.");
			callbacks.onResolved?.();
		} catch (error) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.rejectFailed', "Failed to reject patch: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	private async undo(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, callbacks: ILucosPatchReviewCallbacks): Promise<void> {
		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		try {
			await this.lucosDaemonService.undoPatch(patch.patchId, workspaceRoot);
			actions.style.display = 'none';
			status.textContent = localize('lucos.patch.reverted', "Reverted.");
			callbacks.onReverted?.(patch);
			callbacks.onResolved?.();
		} catch (error) {
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.undoFailed', "Failed to undo patch: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}
}
