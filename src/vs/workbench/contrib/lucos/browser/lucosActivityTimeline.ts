/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ITaskEvent, LucosTaskEventKind } from '../../../../platform/lucos/common/lucosProtocol.js';
import { taskPayloadString } from '../../../../platform/lucos/common/lucosTaskPayload.js';

interface IToolStartedPayload { readonly toolCallId?: string; readonly tool_call_id?: string; readonly toolName?: string; readonly tool_name?: string; readonly safeSummary?: string; readonly safe_summary?: string }
interface IToolCompletedPayload { readonly toolCallId?: string; readonly tool_call_id?: string; readonly toolName?: string; readonly tool_name?: string; readonly status?: string }

const HIDE_DELAY_MS = 400;

export class LucosActivityTimeline extends Disposable {

	private readonly container: HTMLElement;
	private readonly activeEntry: HTMLElement;
	private readonly hideScheduler: RunOnceScheduler;
	private activeToolCount = 0;

	constructor(parent: HTMLElement) {
		super();
		this.container = dom.append(parent, dom.$('.lucos-timeline'));
		this.container.style.display = 'none';
		this.container.style.padding = '4px 8px';
		this.container.style.fontSize = '0.9em';
		this.container.style.opacity = '0.75';
		this.activeEntry = dom.append(this.container, dom.$('.lucos-timeline-entry'));
		this.hideScheduler = this._register(new RunOnceScheduler(() => this.hide(), HIDE_DELAY_MS));
	}

	handleEvent(event: ITaskEvent): void {
		switch (event.kind) {
			case LucosTaskEventKind.ToolStarted: {
				const payload = event.payload as IToolStartedPayload;
				const toolName = taskPayloadString(payload, 'toolName', 'tool_name');
				if (toolName === 'propose_patch' || toolName === 'write_file') {
					break;
				}
				this.hideScheduler.cancel();
				this.activeToolCount++;
				this.show(this.describe(payload));
				break;
			}
			case LucosTaskEventKind.ToolCompleted: {
				const payload = event.payload as IToolCompletedPayload;
				const toolName = taskPayloadString(payload, 'toolName', 'tool_name');
				if (toolName === 'propose_patch' || toolName === 'write_file') {
					break;
				}
				this.activeToolCount = Math.max(0, this.activeToolCount - 1);
				if (this.activeToolCount === 0) {
					this.hideScheduler.schedule();
				}
				break;
			}
		}
	}

	clear(): void {
		this.activeToolCount = 0;
		this.hideScheduler.cancel();
		this.hide();
	}

	finish(): void {
		this.clear();
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
			case 'read_file': return localize('lucos.timeline.reading', "Reading files…");
			case 'run_tests': return localize('lucos.timeline.testing', "Running tests…");
			case 'run_command': return localize('lucos.timeline.running', "Running command…");
			case 'propose_patch':
			case 'write_file': return localize('lucos.timeline.writing', "Writing changes…");
			default: return toolName ?? localize('lucos.timeline.working', "Working…");
		}
	}

	private show(label: string): void {
		this.container.style.display = 'block';
		this.activeEntry.textContent = `⋯ ${label}`;
	}

	private hide(): void {
		this.container.style.display = 'none';
		this.activeEntry.textContent = '';
	}
}
