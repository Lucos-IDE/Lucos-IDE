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
import { makeLucosPatchUri, setLucosPatchContent } from './lucosPatchContentProvider.js';

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

		const reviewState = { status: patch.status };

		for (const change of patch.fileChanges) {
			if (this.isNewFileChange(change) && reviewState.status !== 'applied') {
				const row = dom.append(card, dom.$('.lucos-patch-file-row'));
				const pathEl = dom.append(row, dom.$('a.lucos-patch-file')) as HTMLAnchorElement;
				pathEl.textContent = change.path;
				pathEl.title = localize(
					'lucos.patch.newFilePreviewTitle',
					"Preview proposed new file (not on disk until Accept)",
				);
				this._register(dom.addDisposableListener(pathEl, 'click', () => void this.openDiff(change, reviewState)));
				const badge = dom.append(row, dom.$('span.lucos-patch-file-badge'));
				badge.textContent = localize('lucos.patch.newFileBadge', "new");
				badge.title = localize('lucos.patch.newFilePreviewHint', "Preview proposed contents");
				continue;
			}

			const link = dom.append(card, dom.$('a.lucos-patch-file')) as HTMLAnchorElement;
			link.textContent = change.path;
			link.title = change.path;
			this._register(dom.addDisposableListener(link, 'click', () => void this.openDiff(change, reviewState)));
		}

		const actions = dom.append(card, dom.$('.lucos-patch-actions'));
		const status = dom.append(card, dom.$('.lucos-patch-status'));
		status.style.marginTop = '4px';
		status.style.opacity = '0.8';

		if (reviewState.status === 'applied') {
			this.renderUndoActions(patch, actions, status, callbacks);
			status.textContent = localize('lucos.patch.appliedReady', "Applied — you can undo these changes.");
			return;
		}

		if (reviewState.status === 'reverted') {
			actions.style.display = 'none';
			status.textContent = localize('lucos.patch.reverted', "Reverted.");
			return;
		}

		const acceptButton = dom.append(actions, dom.$('button.lucos-patch-accept')) as HTMLButtonElement;
		acceptButton.textContent = localize('lucos.patch.accept', "Accept");
		const rejectButton = dom.append(actions, dom.$('button.lucos-patch-reject')) as HTMLButtonElement;
		rejectButton.textContent = localize('lucos.patch.reject', "Reject");

		this._register(dom.addDisposableListener(acceptButton, 'click', () => void this.accept(patch, actions, status, callbacks, reviewState)));
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

	private workspaceFileUri(path: string): URI | undefined {
		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			return undefined;
		}
		return URI.joinPath(folder.uri, path);
	}

	private async openDiff(change: ILucosFileChange, reviewState?: { status?: string }): Promise<void> {
		const status = reviewState?.status;
		// After Accept, open the real workspace file — the synthetic review URI is for pending diffs.
		if (status === 'applied') {
			const resource = this.workspaceFileUri(change.path);
			if (!resource) {
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize('lucos.patch.noWorkspace', "No workspace folder is open."),
				});
				return;
			}
			try {
				await this.editorService.openEditor({ resource, options: { pinned: true } });
			} catch (error) {
				this.notificationService.notify({
					severity: Severity.Error,
					message: localize(
						'lucos.patch.openFileFailed',
						"Failed to open {0}: {1}",
						change.path,
						error instanceof Error ? error.message : String(error),
					),
				});
			}
			return;
		}

		const original = makeLucosPatchUri(change.path, 'original');
		const modified = makeLucosPatchUri(change.path, 'modified');
		setLucosPatchContent(original, change.oldText ?? '');
		setLucosPatchContent(modified, change.newText ?? '');

		try {
			await this.editorService.openEditor({
				original: { resource: original },
				modified: { resource: modified },
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

	private async accept(
		patch: ILucosPatchProposal,
		actions: HTMLElement,
		status: HTMLElement,
		callbacks: ILucosPatchReviewCallbacks,
		reviewState: { status?: string },
	): Promise<void> {
		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
		try {
			const result = await this.lucosDaemonService.applyPatch(patch.patchId, workspaceRoot);
			reviewState.status = 'applied';
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
