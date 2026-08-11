/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILucosPermissionRequest, ITaskEvent } from '../../../../platform/lucos/common/lucosProtocol.js';
import { taskPayloadString } from '../../../../platform/lucos/common/lucosTaskPayload.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

/** Converts a `permission.requested` task event into the approval card model. */
export function permissionRequestFromTaskEvent(event: ITaskEvent): ILucosPermissionRequest | undefined {
	const toolCallId = taskPayloadString(event.payload, 'toolCallId', 'tool_call_id');
	const toolName = taskPayloadString(event.payload, 'toolName', 'tool_name');
	if (!toolCallId || !toolName) {
		return undefined;
	}
	return {
		taskId: event.taskId,
		toolCallId,
		toolName,
		command: taskPayloadString(event.payload, 'command', 'command'),
		cwd: taskPayloadString(event.payload, 'cwd', 'cwd'),
		reason: taskPayloadString(event.payload, 'reason', 'reason'),
	};
}

export class LucosCommandApproval extends Disposable {

	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();
	}

	render(container: HTMLElement, request: ILucosPermissionRequest, onResolved?: () => void): void {
		this.renderDisposables.clear();
		dom.clearNode(container);
		container.classList.add('visible');

		const card = dom.append(container, dom.$('.lucos-command-card'));
		dom.append(card, dom.$('.lucos-command-title')).textContent =
			localize('lucos.command.approvalRequired', "Approve Command?");

		const preview = dom.append(card, dom.$('pre.lucos-command-preview'));
		preview.textContent = request.command ?? localize('lucos.command.previewUnavailable', "Command details unavailable");

		if (request.cwd) {
			const cwd = dom.append(card, dom.$('.lucos-command-detail'));
			cwd.textContent = localize('lucos.command.cwd', "Working directory: {0}", request.cwd);
		}
		if (request.reason) {
			const reason = dom.append(card, dom.$('.lucos-command-detail'));
			reason.textContent = localize('lucos.command.reason', "Reason: {0}", request.reason);
		}

		const actions = dom.append(card, dom.$('.lucos-command-actions'));
		const approveButton = dom.append(actions, dom.$('button.lucos-command-approve')) as HTMLButtonElement;
		approveButton.textContent = localize('lucos.command.approve', "Approve");
		const denyButton = dom.append(actions, dom.$('button.lucos-command-deny')) as HTMLButtonElement;
		denyButton.textContent = localize('lucos.command.deny', "Deny");
		const status = dom.append(card, dom.$('.lucos-command-status'));

		this.renderDisposables.add(dom.addDisposableListener(approveButton, 'click', () =>
			void this.respond(request, true, actions, status, approveButton, denyButton, onResolved)));
		this.renderDisposables.add(dom.addDisposableListener(denyButton, 'click', () =>
			void this.respond(request, false, actions, status, approveButton, denyButton, onResolved)));
	}

	private async respond(
		request: ILucosPermissionRequest,
		approved: boolean,
		actions: HTMLElement,
		status: HTMLElement,
		approveButton: HTMLButtonElement,
		denyButton: HTMLButtonElement,
		onResolved?: () => void,
	): Promise<void> {
		approveButton.disabled = true;
		denyButton.disabled = true;
		try {
			await this.lucosDaemonService.respondToPermission(request.taskId, request.toolCallId, approved);
			actions.style.display = 'none';
			status.textContent = approved
				? localize('lucos.command.approved', "Approved.")
				: localize('lucos.command.denied', "Denied.");
			onResolved?.();
		} catch (error) {
			approveButton.disabled = false;
			denyButton.disabled = false;
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize(
					'lucos.command.responseFailed',
					"Failed to respond to command permission: {0}",
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	}
}
