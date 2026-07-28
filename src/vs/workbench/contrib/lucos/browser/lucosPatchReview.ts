/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILucosFileChange, ILucosPatchProposal, LucosFileChangeStatus } from '../../../../platform/lucos/common/lucosProtocol.js';
import { computeLineDiff, ILucosFileDiff } from '../common/lucosDiff.js';
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

/** Max diff rows rendered inline per file before a "view full diff" hint takes over. */
const MAX_INLINE_ROWS = 400;

/** Client-side per-file review state (mirrors daemon FileChange.status, plus a UI-only "rejected"). */
type FileState = 'pending' | 'applied' | 'reverted' | 'rejected';

interface IFileEntry {
	readonly change: ILucosFileChange;
	readonly diff: ILucosFileDiff;
	state: FileState;
	/** Toolbar for this file's actions, re-rendered on state change. */
	readonly actionsEl: HTMLElement;
	/** Status pill (Applied / Reverted / Rejected). */
	readonly stateEl: HTMLElement;
	busy: boolean;
}

export class LucosPatchReview extends Disposable {

	/** Static listeners for the currently rendered card (file headers, open-diff); cleared on each render. */
	private readonly renderDisposables = this._register(new DisposableStore());

	/** Action-button listeners, rebuilt on every {@link refresh} so they never accumulate. */
	private readonly refreshDisposables = this._register(new DisposableStore());

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();
	}

	render(container: HTMLElement, patch: ILucosPatchProposal, onResolved?: () => void): void {
		this.renderDisposables.clear();
		dom.clearNode(container);
		container.classList.add('visible');

		const card = dom.append(container, dom.$('.lucos-patch-card'));

		const header = dom.append(card, dom.$('.lucos-patch-header'));
		const title = dom.append(header, dom.$('.lucos-patch-title'));
		title.textContent = patch.summary || localize('lucos.patch.proposed', "Proposed changes");
		const headerStats = dom.append(header, dom.$('.lucos-patch-headerstats'));

		const entries: IFileEntry[] = [];
		const filesEl = dom.append(card, dom.$('.lucos-patch-files'));
		for (const change of patch.fileChanges) {
			const diff = computeLineDiff(change.oldText, change.newText, { maxRows: MAX_INLINE_ROWS });
			entries.push(this.renderFile(filesEl, change, diff));
		}

		const cardActions = dom.append(card, dom.$('.lucos-patch-actions'));
		const status = dom.append(card, dom.$('.lucos-patch-status'));

		this.refresh(patch, entries, headerStats, cardActions, status, onResolved);
	}

	/** Recompute aggregate header, card-level actions, and summary from current per-file state. */
	private refresh(
		patch: ILucosPatchProposal,
		entries: IFileEntry[],
		headerStats: HTMLElement,
		cardActions: HTMLElement,
		status: HTMLElement,
		onResolved?: () => void,
	): void {
		this.refreshDisposables.clear();
		const totals = entries.reduce((acc, e) => ({ additions: acc.additions + e.diff.additions, deletions: acc.deletions + e.diff.deletions }), { additions: 0, deletions: 0 });
		dom.clearNode(headerStats);
		dom.append(headerStats, dom.$('span')).textContent = localize('lucos.patch.fileCount', "{0} file(s)", entries.length);
		this.appendStatBadge(headerStats, totals.additions, totals.deletions);

		for (const entry of entries) {
			this.renderFileActions(entry, patch, () => this.refresh(patch, entries, headerStats, cardActions, status, onResolved));
		}

		const pending = entries.filter(e => e.state === 'pending');
		const applied = entries.filter(e => e.state === 'applied');

		dom.clearNode(cardActions);
		if (pending.length > 0) {
			const acceptAll = dom.append(cardActions, dom.$('button.lucos-patch-accept')) as HTMLButtonElement;
			acceptAll.textContent = pending.length === entries.length
				? localize('lucos.patch.acceptAll', "Accept all")
				: localize('lucos.patch.acceptRemaining', "Accept remaining ({0})", pending.length);
			this.refreshDisposables.add(dom.addDisposableListener(acceptAll, 'click', () => void this.applyFiles(patch, pending, () => this.refresh(patch, entries, headerStats, cardActions, status, onResolved))));

			// Reject-all discards the whole pending patch; only offered before anything is applied.
			if (applied.length === 0) {
				const rejectAll = dom.append(cardActions, dom.$('button.lucos-patch-reject')) as HTMLButtonElement;
				rejectAll.textContent = localize('lucos.patch.rejectAll', "Reject all");
				this.refreshDisposables.add(dom.addDisposableListener(rejectAll, 'click', () => void this.rejectAll(patch, entries, () => this.refresh(patch, entries, headerStats, cardActions, status, onResolved))));
			}
		} else if (applied.length > 0) {
			const revertAll = dom.append(cardActions, dom.$('button.lucos-patch-reject')) as HTMLButtonElement;
			revertAll.textContent = localize('lucos.patch.revertAll', "Revert all");
			this.refreshDisposables.add(dom.addDisposableListener(revertAll, 'click', () => void this.revertFiles(patch, applied, () => this.refresh(patch, entries, headerStats, cardActions, status, onResolved))));
		}

		this.renderSummary(status, entries);

		if (pending.length === 0) {
			onResolved?.();
		}
	}

	/** One collapsible file section: header (chevron · path · stats · actions) + inline diff body. */
	private renderFile(parent: HTMLElement, change: ILucosFileChange, diff: ILucosFileDiff): IFileEntry {
		const file = dom.append(parent, dom.$('.lucos-patch-file'));

		const fileHeader = dom.append(file, dom.$('.lucos-patch-file-header'));

		const chevron = dom.append(fileHeader, dom.$('span.lucos-patch-chevron'));
		chevron.classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));

		const badge = dom.append(fileHeader, dom.$('span.lucos-patch-file-badge'));
		badge.classList.add(...ThemeIcon.asClassNameArray(this.changeIcon(diff)));
		badge.title = this.changeKindLabel(diff);

		const name = dom.append(fileHeader, dom.$('span.lucos-patch-file-path'));
		const { dir, base } = splitPath(change.path);
		dom.append(name, dom.$('span.lucos-patch-file-name')).textContent = base;
		if (dir) {
			dom.append(name, dom.$('span.lucos-patch-file-dir')).textContent = dir;
		}

		const stats = dom.append(fileHeader, dom.$('span.lucos-patch-file-stats'));
		this.appendStatBadge(stats, diff.additions, diff.deletions);

		const stateEl = dom.append(fileHeader, dom.$('span.lucos-patch-file-state'));
		const actionsEl = dom.append(fileHeader, dom.$('span.lucos-patch-file-actions'));

		const openBtn = dom.append(fileHeader, dom.$('span.lucos-patch-file-open')) as HTMLElement;
		openBtn.classList.add(...ThemeIcon.asClassNameArray(Codicon.diffSingle));
		openBtn.title = localize('lucos.patch.openDiff', "Open full diff");
		openBtn.setAttribute('role', 'button');
		openBtn.tabIndex = 0;

		const body = dom.append(file, dom.$('.lucos-patch-file-body'));
		this.renderDiffRows(body, diff);

		// Chevron collapse toggles the body; clicks on interactive controls are ignored.
		const toggle = () => {
			const collapsed = file.classList.toggle('collapsed');
			chevron.classList.remove(...ThemeIcon.asClassNameArray(Codicon.chevronDown), ...ThemeIcon.asClassNameArray(Codicon.chevronRight));
			chevron.classList.add(...ThemeIcon.asClassNameArray(collapsed ? Codicon.chevronRight : Codicon.chevronDown));
		};
		this.renderDisposables.add(dom.addDisposableListener(fileHeader, 'click', e => {
			const target = e.target as Node;
			if (openBtn.contains(target) || actionsEl.contains(target)) {
				return;
			}
			toggle();
		}));
		const openDiff = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			void this.openDiff(change);
		};
		this.renderDisposables.add(dom.addDisposableListener(openBtn, 'click', openDiff));
		this.renderDisposables.add(dom.addDisposableListener(openBtn, 'keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				openDiff(e);
			}
		}));

		return {
			change,
			diff,
			state: this.initialState(change),
			actionsEl,
			stateEl,
			busy: false,
		};
	}

	/** Rebuild a file's action toolbar + status pill to match its current state. */
	private renderFileActions(entry: IFileEntry, patch: ILucosPatchProposal, refresh: () => void): void {
		dom.clearNode(entry.actionsEl);
		dom.clearNode(entry.stateEl);
		entry.stateEl.className = 'lucos-patch-file-state';

		const addButton = (label: string, kind: 'accept' | 'reject', run: () => Promise<void>) => {
			const btn = dom.append(entry.actionsEl, dom.$(`button.lucos-patch-mini.${kind}`)) as HTMLButtonElement;
			btn.textContent = label;
			btn.disabled = entry.busy;
			this.refreshDisposables.add(dom.addDisposableListener(btn, 'click', e => {
				e.stopPropagation();
				void run();
			}));
		};

		switch (entry.state) {
			case 'pending':
				addButton(localize('lucos.patch.accept', "Accept"), 'accept', () => this.applyFiles(patch, [entry], refresh));
				addButton(localize('lucos.patch.reject', "Reject"), 'reject', async () => { entry.state = 'rejected'; refresh(); });
				break;
			case 'applied':
				entry.stateEl.classList.add('applied');
				entry.stateEl.textContent = localize('lucos.patch.stateApplied', "Applied");
				addButton(localize('lucos.patch.revert', "Revert"), 'reject', () => this.revertFiles(patch, [entry], refresh));
				break;
			case 'reverted':
				entry.stateEl.classList.add('reverted');
				entry.stateEl.textContent = localize('lucos.patch.stateReverted', "Reverted");
				addButton(localize('lucos.patch.reapply', "Re-apply"), 'accept', () => this.applyFiles(patch, [entry], refresh));
				break;
			case 'rejected':
				entry.stateEl.classList.add('rejected');
				entry.stateEl.textContent = localize('lucos.patch.stateRejected', "Rejected");
				addButton(localize('lucos.patch.restore', "Restore"), 'accept', async () => { entry.state = 'pending'; refresh(); });
				break;
		}
	}

	private renderDiffRows(body: HTMLElement, diff: ILucosFileDiff): void {
		for (const row of diff.rows) {
			if (row.type === 'gap') {
				const gap = dom.append(body, dom.$('.lucos-diff-row.gap'));
				dom.append(gap, dom.$('span.lucos-diff-gutter'));
				dom.append(gap, dom.$('span.lucos-diff-text')).textContent = localize('lucos.patch.hiddenLines', "⋯ {0} unchanged line(s)", row.hiddenCount ?? 0);
				continue;
			}
			const rowEl = dom.append(body, dom.$(`.lucos-diff-row.${row.type}`));
			const oldGutter = dom.append(rowEl, dom.$('span.lucos-diff-gutter.old'));
			oldGutter.textContent = row.oldLine !== undefined ? String(row.oldLine) : '';
			const newGutter = dom.append(rowEl, dom.$('span.lucos-diff-gutter.new'));
			newGutter.textContent = row.newLine !== undefined ? String(row.newLine) : '';
			const sign = dom.append(rowEl, dom.$('span.lucos-diff-sign'));
			sign.textContent = row.type === 'add' ? '+' : row.type === 'del' ? '-' : '';
			const text = dom.append(rowEl, dom.$('span.lucos-diff-text'));
			text.textContent = row.text.length ? row.text : '\u200b';
		}
		if (diff.truncated) {
			const note = dom.append(body, dom.$('.lucos-diff-row.gap'));
			dom.append(note, dom.$('span.lucos-diff-gutter'));
			dom.append(note, dom.$('span.lucos-diff-text')).textContent = localize('lucos.patch.diffTruncated', "Diff truncated — open the full diff to see everything.");
		}
	}

	private appendStatBadge(parent: HTMLElement, additions: number, deletions: number): void {
		const badge = dom.append(parent, dom.$('span.lucos-diff-stat'));
		if (additions > 0) {
			dom.append(badge, dom.$('span.add')).textContent = `+${additions}`;
		}
		if (deletions > 0) {
			dom.append(badge, dom.$('span.del')).textContent = `-${deletions}`;
		}
		if (additions === 0 && deletions === 0) {
			dom.append(badge, dom.$('span')).textContent = localize('lucos.patch.noChanges', "no changes");
		}
	}

	private renderSummary(status: HTMLElement, entries: IFileEntry[]): void {
		dom.clearNode(status);
		const applied = entries.filter(e => e.state === 'applied');
		const reverted = entries.filter(e => e.state === 'reverted');
		const rejected = entries.filter(e => e.state === 'rejected');
		if (applied.length === 0 && reverted.length === 0 && rejected.length === 0) {
			return;
		}

		const summary = dom.append(status, dom.$('.lucos-patch-summary'));
		dom.append(summary, dom.$('.lucos-patch-summary-title')).textContent = localize('lucos.patch.summaryTitle', "Summary of changes");

		let totalAdd = 0;
		let totalDel = 0;
		for (const entry of applied) {
			totalAdd += entry.diff.additions;
			totalDel += entry.diff.deletions;
			const row = dom.append(summary, dom.$('.lucos-patch-summary-row'));
			const kind = dom.append(row, dom.$('span.lucos-patch-summary-kind'));
			kind.textContent = this.changeKindLabel(entry.diff);
			kind.classList.add(entry.diff.isNew ? 'added' : entry.diff.isDeleted ? 'deleted' : 'modified');
			dom.append(row, dom.$('span.lucos-patch-summary-path')).textContent = entry.change.path;
			this.appendStatBadge(row, entry.diff.additions, entry.diff.deletions);
		}

		const totalsRow = dom.append(summary, dom.$('.lucos-patch-summary-total'));
		const parts: string[] = [];
		if (applied.length) { parts.push(localize('lucos.patch.summaryApplied', "{0} applied", applied.length)); }
		if (reverted.length) { parts.push(localize('lucos.patch.summaryReverted', "{0} reverted", reverted.length)); }
		if (rejected.length) { parts.push(localize('lucos.patch.summaryRejected', "{0} rejected", rejected.length)); }
		dom.append(totalsRow, dom.$('span')).textContent = parts.join(' · ');
		if (applied.length) {
			this.appendStatBadge(totalsRow, totalAdd, totalDel);
		}
	}

	private initialState(change: ILucosFileChange): FileState {
		switch (change.status) {
			case LucosFileChangeStatus.Applied: return 'applied';
			case LucosFileChangeStatus.Reverted: return 'reverted';
			default: return 'pending';
		}
	}

	private changeIcon(diff: ILucosFileDiff): ThemeIcon {
		if (diff.isNew) {
			return Codicon.diffAdded;
		}
		if (diff.isDeleted) {
			return Codicon.diffRemoved;
		}
		return Codicon.diffModified;
	}

	private changeKindLabel(diff: ILucosFileDiff): string {
		if (diff.isNew) {
			return localize('lucos.patch.added', "Added");
		}
		if (diff.isDeleted) {
			return localize('lucos.patch.deleted', "Deleted");
		}
		return localize('lucos.patch.modified', "Modified");
	}

	private renderUndoActions(patch: ILucosPatchProposal, actions: HTMLElement, status: HTMLElement, callbacks: ILucosPatchReviewCallbacks): void {
		dom.clearNode(actions);
		actions.style.display = '';
		const undoButton = dom.append(actions, dom.$('button.lucos-patch-undo')) as HTMLButtonElement;
		undoButton.textContent = localize('lucos.patch.undo', "Undo");
		this._register(dom.addDisposableListener(undoButton, 'click', () => void this.undo(patch, actions, status, callbacks)));
	}

	private get workspaceRoot(): string {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '';
	}

	/** Apply the given file entries (Cursor-style per-file / remaining accept). */
	private async applyFiles(patch: ILucosPatchProposal, targets: IFileEntry[], refresh: () => void): Promise<void> {
		if (targets.length === 0) {
			return;
		}
		targets.forEach(t => t.busy = true);
		refresh();
		try {
			const paths = targets.map(t => t.change.path);
			await this.lucosDaemonService.applyPatch(patch.patchId, this.workspaceRoot, paths);
			targets.forEach(t => { t.state = 'applied'; t.busy = false; });
			refresh();
		} catch (error) {
			targets.forEach(t => t.busy = false);
			refresh();
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.applyFailed', "Failed to apply patch: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	/** Revert previously applied file entries back to pre-patch content. */
	private async revertFiles(patch: ILucosPatchProposal, targets: IFileEntry[], refresh: () => void): Promise<void> {
		if (targets.length === 0) {
			return;
		}
		targets.forEach(t => t.busy = true);
		refresh();
		try {
			const paths = targets.map(t => t.change.path);
			await this.lucosDaemonService.revertPatchFiles(patch.patchId, this.workspaceRoot, paths);
			targets.forEach(t => { t.state = 'reverted'; t.busy = false; });
			refresh();
		} catch (error) {
			targets.forEach(t => t.busy = false);
			refresh();
			this.notificationService.notify({ severity: Severity.Error, message: localize('lucos.patch.revertFailed', "Failed to revert changes: {0}", error instanceof Error ? error.message : String(error)) });
		}
	}

	private async rejectAll(patch: ILucosPatchProposal, entries: IFileEntry[], refresh: () => void): Promise<void> {
		try {
			await this.lucosDaemonService.rejectPatch(patch.patchId);
			entries.forEach(e => { if (e.state === 'pending') { e.state = 'rejected'; } });
			refresh();
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

/** Split a workspace-relative path into `{ dir, base }` for two-tone rendering. */
function splitPath(path: string): { dir: string; base: string } {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
	const slash = normalized.lastIndexOf('/');
	if (slash < 0) {
		return { dir: '', base: normalized };
	}
	return { dir: normalized.slice(0, slash), base: normalized.slice(slash + 1) };
}
