/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ITaskEvent, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';
import { taskPayloadString } from '../../../../platform/lucos/common/lucosTaskPayload.js';

interface IToolStartedPayload {
	readonly toolCallId?: string;
	readonly tool_call_id?: string;
	readonly toolName?: string;
	readonly tool_name?: string;
	readonly safeSummary?: string;
	readonly safe_summary?: string;
}

interface IToolCompletedPayload {
	readonly toolCallId?: string;
	readonly tool_call_id?: string;
	readonly toolName?: string;
	readonly tool_name?: string;
	readonly safeSummary?: string;
	readonly safe_summary?: string;
	readonly status?: string;
}

interface IActivityStep {
	readonly id: string;
	readonly toolName: string;
	label: string;
	completed: boolean;
}

type LivePhase = 'idle' | 'thinking' | 'analyzing';

/**
 * Live tool activity + Cursor-like post-turn collapsible summary card.
 * Finished summary cards stay in the turn footer; the live row is reused across turns.
 */
export class LucosActivityTimeline extends Disposable {

	private readonly liveContainer: HTMLElement;
	private readonly activeEntry: HTMLElement;
	private readonly phaseLabel: HTMLElement;
	private readonly detailLabel: HTMLElement;
	private readonly pulse: HTMLElement;
	/** Listeners for finished summary cards; cleared only when the chat view is wiped. */
	private readonly summaryDisposables = this._register(new DisposableStore());
	private steps: IActivityStep[] = [];
	private activeToolCount = 0;
	private mountedParent: HTMLElement | undefined;
	private stepSeq = 0;
	private phase: LivePhase = 'idle';
	private turnActive = false;

	constructor() {
		super();
		this.liveContainer = dom.$('.lucos-timeline');
		this.activeEntry = dom.append(this.liveContainer, dom.$('.lucos-timeline-entry'));
		this.pulse = dom.append(this.activeEntry, dom.$('span.lucos-timeline-pulse'));
		this.pulse.setAttribute('aria-hidden', 'true');
		for (let i = 0; i < 3; i++) {
			dom.append(this.pulse, dom.$('span.lucos-timeline-pulse-dot'));
		}
		this.phaseLabel = dom.append(this.activeEntry, dom.$('span.lucos-timeline-phase'));
		this.detailLabel = dom.append(this.activeEntry, dom.$('span.lucos-timeline-detail'));
	}

	mountTo(parent: HTMLElement): void {
		if (this.mountedParent === parent) {
			return;
		}
		this.unmount();
		// Keep live row above patch/permission slots when present.
		parent.insertBefore(this.liveContainer, parent.firstChild);
		this.mountedParent = parent;
	}

	unmount(): void {
		this.liveContainer.remove();
		this.mountedParent = undefined;
	}

	/** Show Thinking… as soon as the assistant turn starts (before tools). */
	beginThinking(): void {
		this.turnActive = true;
		this.setPhase('thinking');
	}

	handleEvent(event: ITaskEvent): void {
		switch (event.kind) {
			case LucosTaskEventKind.ToolStarted: {
				const payload = event.payload as IToolStartedPayload;
				const toolName = taskPayloadString(payload, 'toolName', 'tool_name') ?? '';
				const id = taskPayloadString(payload, 'toolCallId', 'tool_call_id')
					?? `step-${++this.stepSeq}`;
				const label = this.describe(payload);
				this.steps.push({ id, toolName, label, completed: false });
				this.activeToolCount++;
				this.turnActive = true;
				if (!this.isSilentTool(toolName)) {
					this.setPhase('analyzing', label);
				} else if (this.phase === 'thinking' || this.phase === 'idle') {
					// Still show progress while a silent write tool runs.
					this.setPhase('analyzing', localize('lucos.timeline.analyzing', "Analyzing…"));
				}
				break;
			}
			case LucosTaskEventKind.ToolCompleted: {
				const payload = event.payload as IToolCompletedPayload;
				const toolName = taskPayloadString(payload, 'toolName', 'tool_name') ?? '';
				const id = taskPayloadString(payload, 'toolCallId', 'tool_call_id');
				const completedLabel = taskPayloadString(payload, 'safeSummary', 'safe_summary')?.trim();
				const step = id
					? this.steps.find(s => s.id === id)
					: [...this.steps].reverse().find(s => s.toolName === toolName && !s.completed);
				if (step) {
					step.completed = true;
					if (completedLabel) {
						step.label = completedLabel;
					}
				}
				this.activeToolCount = Math.max(0, this.activeToolCount - 1);
				if (this.activeToolCount === 0 && this.turnActive) {
					// Between tool rounds the model is thinking again.
					this.setPhase('thinking');
				}
				break;
			}
			case LucosTaskEventKind.ModelDelta: {
				if (this.turnActive && this.activeToolCount === 0 && this.phase === 'idle') {
					this.setPhase('thinking');
				}
				break;
			}
		}
	}

	clear(): void {
		this.steps = [];
		this.activeToolCount = 0;
		this.turnActive = false;
		this.setPhase('idle');
	}

	/** Drop finished summary card listeners when the conversation DOM is rebuilt. */
	clearSummaries(): void {
		this.summaryDisposables.clear();
	}

	/**
	 * End of turn: leave a collapsible summary box in the turn footer (if any tools ran),
	 * then reset the live row for the next request.
	 */
	finish(): void {
		const parent = this.mountedParent;
		const snapshot = this.steps.slice();
		this.clear();
		if (!parent || snapshot.length === 0) {
			return;
		}
		this.renderSummaryCard(parent, snapshot);
	}

	private setPhase(phase: LivePhase, detail?: string): void {
		this.phase = phase;
		this.liveContainer.classList.toggle('visible', phase !== 'idle');
		this.liveContainer.classList.toggle('thinking', phase === 'thinking');
		this.liveContainer.classList.toggle('analyzing', phase === 'analyzing');
		this.liveContainer.setAttribute('aria-busy', phase !== 'idle' ? 'true' : 'false');

		if (phase === 'idle') {
			this.phaseLabel.textContent = '';
			this.detailLabel.textContent = '';
			return;
		}

		if (phase === 'thinking') {
			this.phaseLabel.textContent = localize('lucos.timeline.thinking', "Thinking");
			this.detailLabel.textContent = '';
			return;
		}

		this.phaseLabel.textContent = localize('lucos.timeline.analyzingPhase', "Analyzing");
		this.detailLabel.textContent = detail?.trim() || '';
	}

	private renderSummaryCard(parent: HTMLElement, steps: readonly IActivityStep[]): void {
		for (const child of Array.from(parent.children)) {
			if (child.classList.contains('lucos-activity-summary')) {
				child.remove();
			}
		}

		const card = dom.$('.lucos-activity-summary');
		const header = dom.append(card, dom.$('button.lucos-activity-summary-header')) as HTMLButtonElement;
		header.type = 'button';
		header.setAttribute('aria-expanded', 'false');

		const chevron = dom.append(header, dom.$('span.lucos-activity-summary-chevron'));
		// allow-any-unicode-next-line
		chevron.textContent = '▸';
		chevron.setAttribute('aria-hidden', 'true');

		const title = dom.append(header, dom.$('span.lucos-activity-summary-title'));
		title.textContent = this.summarize(steps);

		const details = dom.append(card, dom.$('.lucos-activity-summary-details'));
		for (const step of steps) {
			const row = dom.append(details, dom.$('.lucos-activity-summary-row'));
			row.textContent = step.label;
		}

		const toggle = () => {
			const open = card.classList.toggle('expanded');
			header.setAttribute('aria-expanded', String(open));
			// allow-any-unicode-next-line
			chevron.textContent = open ? '▾' : '▸';
		};
		this.summaryDisposables.add(dom.addDisposableListener(header, 'click', toggle));

		// Insert after live timeline (if mounted), otherwise at top of footer.
		if (this.liveContainer.parentElement === parent) {
			parent.insertBefore(card, this.liveContainer.nextSibling);
		} else {
			parent.insertBefore(card, parent.firstChild);
		}
	}

	private summarize(steps: readonly IActivityStep[]): string {
		let filesRead = 0;
		let searches = 0;
		let patches = 0;
		let commands = 0;
		const seenFiles = new Set<string>();

		for (const step of steps) {
			switch (step.toolName) {
				case 'read_file': {
					const path = this.pathFromReadLabel(step.label);
					const key = path || step.label;
					if (!seenFiles.has(key)) {
						seenFiles.add(key);
						filesRead++;
					}
					break;
				}
				case 'search_text':
				case 'semantic_search':
				case 'web_search':
					searches++;
					break;
				case 'propose_patch':
				case 'write_file':
					patches++;
					break;
				case 'run_command':
				case 'run_tests':
					commands++;
					break;
			}
		}

		const parts: string[] = [];
		if (filesRead > 0) {
			parts.push(filesRead === 1
				? localize('lucos.activity.reviewedOne', "Reviewed 1 file")
				: localize('lucos.activity.reviewedMany', "Reviewed {0} files", filesRead));
		}
		if (searches > 0) {
			parts.push(searches === 1
				? localize('lucos.activity.searchedOne', "Searched once")
				: localize('lucos.activity.searchedMany', "Searched {0} times", searches));
		}
		if (patches > 0) {
			parts.push(patches === 1
				? localize('lucos.activity.proposedOne', "Proposed changes")
				: localize('lucos.activity.proposedMany', "Proposed {0} changes", patches));
		}
		if (commands > 0) {
			parts.push(commands === 1
				? localize('lucos.activity.ranOne', "Ran 1 command")
				: localize('lucos.activity.ranMany', "Ran {0} commands", commands));
		}

		if (parts.length > 0) {
			return parts.join(' · ');
		}
		return steps.length === 1
			? localize('lucos.activity.exploredOne', "Explored 1 step")
			: localize('lucos.activity.exploredMany', "Explored {0} steps", steps.length);
	}

	private pathFromReadLabel(label: string): string | undefined {
		const match = /^(?:Reading|Read)\s+(.+?)(?:\.…)?$/i.exec(label.trim());
		return match?.[1]?.trim() || undefined;
	}

	private isSilentTool(toolName: string): boolean {
		// Patch card already surfaces write proposals; keep them in the summary only.
		return toolName === 'propose_patch' || toolName === 'write_file';
	}

	private describe(payload: IToolStartedPayload): string {
		const summary = taskPayloadString(payload, 'safeSummary', 'safe_summary')?.trim();
		if (summary) {
			return summary;
		}
		const toolName = taskPayloadString(payload, 'toolName', 'tool_name');
		switch (toolName) {
			case 'search_text':
			case 'semantic_search': return localize('lucos.timeline.searching', "Searching…");
			case 'web_search': return localize('lucos.timeline.webSearching', "Searching the web…");
			case 'read_file': return localize('lucos.timeline.reading', "Reading files…");
			case 'run_tests': return localize('lucos.timeline.testing', "Running tests…");
			case 'run_command': return localize('lucos.timeline.running', "Running command…");
			case 'propose_patch':
			case 'write_file': return localize('lucos.timeline.writing', "Writing changes…");
			default: return toolName ?? localize('lucos.timeline.working', "Working…");
		}
	}
}
