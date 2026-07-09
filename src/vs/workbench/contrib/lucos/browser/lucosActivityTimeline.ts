/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — activity timeline widget (TW-162).
 *  Renders the agent's live tool activity (Searching / Reading / Running tests …) from the task
 *  event stream. Consumes only ITaskEvent, so it lights up automatically once the daemon emits
 *  real tool events (today the stub emits none, so it stays hidden).
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ITaskEvent, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';

interface IToolStartedPayload { readonly toolCallId?: string; readonly toolName?: string; readonly safeSummary?: string }
interface IToolCompletedPayload { readonly toolCallId?: string; readonly status?: string }

export class LucosActivityTimeline extends Disposable {

	private readonly container: HTMLElement;
	private readonly entries = new Map<string, HTMLElement>();

	constructor(parent: HTMLElement) {
		super();
		this.container = dom.append(parent, dom.$('.lucos-timeline'));
		this.container.style.display = 'none';
		this.container.style.padding = '4px 8px';
		this.container.style.fontSize = '0.9em';
		this.container.style.opacity = '0.8';
	}

	handleEvent(event: ITaskEvent): void {
		switch (event.kind) {
			case LucosTaskEventKind.ToolStarted: {
				const payload = event.payload as IToolStartedPayload;
				this.addEntry(payload.toolCallId ?? `seq-${event.sequence}`, this.describe(payload));
				break;
			}
			case LucosTaskEventKind.ToolCompleted: {
				const payload = event.payload as IToolCompletedPayload;
				if (payload.toolCallId) {
					this.markComplete(payload.toolCallId);
				}
				break;
			}
		}
	}

	clear(): void {
		this.entries.clear();
		dom.clearNode(this.container);
		this.container.style.display = 'none';
	}

	private describe(payload: IToolStartedPayload): string {
		const summary = payload.safeSummary?.trim();
		if (summary) {
			return summary;
		}
		switch (payload.toolName) {
			case 'search_text':
			case 'semantic_search': return localize('lucos.timeline.searching', "Searching…");
			case 'read_file': return localize('lucos.timeline.reading', "Reading files…");
			case 'run_tests': return localize('lucos.timeline.testing', "Running tests…");
			case 'run_command': return localize('lucos.timeline.running', "Running command…");
			case 'propose_patch':
			case 'write_file': return localize('lucos.timeline.writing', "Writing changes…");
			default: return payload.toolName ?? localize('lucos.timeline.working', "Working…");
		}
	}

	private addEntry(id: string, label: string): void {
		this.container.style.display = 'block';
		let entry = this.entries.get(id);
		if (!entry) {
			entry = dom.append(this.container, dom.$('.lucos-timeline-entry'));
			this.entries.set(id, entry);
		}
		entry.textContent = `⋯ ${label}`;
	}

	private markComplete(id: string): void {
		const entry = this.entries.get(id);
		if (entry?.textContent) {
			entry.textContent = entry.textContent.replace(/^⋯/, '✓');
		}
	}
}
