/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILucosPermissionRequest } from '../../../../platform/lucos/common/lucosProtocol.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';

export class LucosCommandApproval extends Disposable {

	constructor(
		@INotificationService private readonly notificationService: INotificationService,
		@ILucosDaemonService private readonly lucosDaemonService: ILucosDaemonService,
	) {
		super();
	}

	render(container: HTMLElement, request: ILucosPermissionRequest, onResolved?: () => void): void {
		dom.clearNode(container);
		container.classList.add('visible');

		const card = dom.append(container, dom.$('.lucos-command-card'));

		const title = dom.append(card, dom.$('.lucos-command-title'));
		title.textContent = localize('lucos.command.approvalTitle', "Allow command?");

		const tool = dom.append(card, dom.$('.lucos-command-tool'));
		tool.textContent = request.toolName || 'run_command';

		if (request.command) {
			const preview = dom.append(card, dom.$('pre.lucos-command-preview'));
			preview.textContent = request.command;
		}

		if (request.cwd) {
			const cwd = dom.append(card, dom.$('.lucos-command-cwd'));
			cwd.textContent = localize('lucos.command.cwd', "cwd: {0}", request.cwd);
		}

		if (request.reason) {
			const reason = dom.append(card, dom.$('.lucos-command-reason'));
			reason.textContent = request.reason;
		}

		const actions = dom.append(card, dom.$('.lucos-command-actions'));

		const approveButton = dom.append(actions, dom.$('button.lucos-command-approve')) as HTMLButtonElement;
		approveButton.textContent = localize('lucos.command.approve', "Approve");
		const denyButton = dom.append(actions, dom.$('button.lucos-command-deny')) as HTMLButtonElement;
		denyButton.textContent = localize('lucos.command.deny', "Deny");

		const status = dom.append(card, dom.$('.lucos-command-status'));

		this._register(dom.addDisposableListener(approveButton, 'click', () => void this.respond(request, true, actions, status, onResolved)));
		this._register(dom.addDisposableListener(denyButton, 'click', () => void this.respond(request, false, actions, status, onResolved)));
	}

	private async respond(
		request: ILucosPermissionRequest,
		approved: boolean,
		actions: HTMLElement,
		status: HTMLElement,
		onResolved?: () => void,
	): Promise<void> {
		try {
			await this.lucosDaemonService.respondToPermission(
				request.taskId,
				request.toolCallId,
				approved,
				approved ? undefined : localize('lucos.command.userDenied', "User denied"),
			);
			actions.style.display = 'none';
			status.textContent = approved
				? localize('lucos.command.approved', "Approved.")
				: localize('lucos.command.denied', "Denied.");
			onResolved?.();
		} catch (error) {
			this.notificationService.notify({
				severity: Severity.Error,
				message: localize(
					'lucos.command.respondFailed',
					"Failed to respond to permission: {0}",
					error instanceof Error ? error.message : String(error),
				),
			});
		}
	}
}
