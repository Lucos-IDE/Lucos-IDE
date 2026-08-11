/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lucos IDE - status popover (gear in the Lucos view title).
// Shows live Lucos metadata - index state, daemon, account, model - in a quick-pick, plus
// quick actions (re-index, open settings). Designed to grow: add a row to buildStatusRows() as
// new metadata (cloud sync, quota, ...) comes online.

import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { ILucosAuthStatus, ILucosIndexStatus, LucosAuthState, LucosConnectionState, LucosIndexState } from '../../../../platform/lucos/common/lucosProtocol.js';
import { LucosSettingId } from '../common/lucosConfiguration.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { ILucosIndexService } from '../common/lucosIndexService.js';
import { LUCOS_CHAT_VIEW_ID } from './lucosCommands.js';

const LUCOS_CATEGORY = localize2('lucos', "Lucos");

/** Actionable rows carry an id; informational rows omit it (selecting them does nothing). */
interface IStatusPickItem extends IQuickPickItem {
	readonly id?: 'reindex' | 'settings';
}

/**
 * Gear (in the Lucos view title) that opens a live status popover. This is the single place the
 * lead asked for to surface indexing status and other metadata we add over time.
 */
export class LucosShowStatusAction extends Action2 {
	static readonly ID = 'lucos.showStatus';
	constructor() {
		super({
			id: LucosShowStatusAction.ID,
			title: localize2('lucos.showStatus.title', "Lucos Status"),
			category: LUCOS_CATEGORY,
			f1: true,
			icon: Codicon.gear,
			menu: [{
				id: MenuId.ViewTitle,
				when: ContextKeyExpr.equals('view', LUCOS_CHAT_VIEW_ID),
				group: 'navigation',
				order: 1,
			}],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Resolve all services synchronously (accessor is only valid before the first await).
		const indexService = accessor.get(ILucosIndexService);
		const daemonService = accessor.get(ILucosDaemonService);
		const configurationService = accessor.get(IConfigurationService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);

		const connected = daemonService.connectionState === LucosConnectionState.Connected;

		// Daemon version is a best-effort extra; never block the popover on it.
		let version = '';
		if (connected) {
			try {
				version = (await daemonService.health()).version ?? '';
			} catch {
				// leave version blank
			}
		}

		const model = configurationService.getValue<string>(LucosSettingId.AgentModel) ?? '';
		const rows = buildStatusRows(indexService.status, daemonService.connectionState, daemonService.authStatus, model, version);

		const separator: IQuickPickSeparator = { type: 'separator', label: localize('lucos.showStatus.actions', "Actions") };
		const actions: IStatusPickItem[] = [
			{ id: 'reindex', label: '$(sync) ' + localize('lucos.showStatus.reindex', "Re-index Workspace") },
			{ id: 'settings', label: '$(gear) ' + localize('lucos.showStatus.settings', "Open Lucos Settings") },
		];

		const pick = await quickInputService.pick<IStatusPickItem>([...rows, separator, ...actions], {
			placeHolder: localize('lucos.showStatus.placeholder', "Lucos status"),
		});

		if (pick?.id === 'reindex') {
			await indexService.index(true);
		} else if (pick?.id === 'settings') {
			await commandService.executeCommand('workbench.action.openSettings', '@tag:lucos');
		}
	}
}

/** Build the informational rows. Append here as new metadata comes online. */
function buildStatusRows(index: ILucosIndexStatus, connection: LucosConnectionState, auth: ILucosAuthStatus, model: string, version: string): IStatusPickItem[] {
	const connected = connection === LucosConnectionState.Connected;
	return [
		{ label: '$(database) ' + localize('lucos.showStatus.index', "Index"), description: describeIndex(index) },
		{
			label: '$(plug) ' + localize('lucos.showStatus.daemon', "Daemon"),
			description: connected
				? (version ? localize('lucos.showStatus.daemonConnectedVersion', "Connected · {0}", version) : localize('lucos.showStatus.daemonConnected', "Connected"))
				: localize('lucos.showStatus.daemonOffline', "Offline"),
		},
		buildAccountRow(auth),
		{ label: '$(sparkle) ' + localize('lucos.showStatus.model', "Model"), description: model || '—' },
	];
}

function buildAccountRow(auth: ILucosAuthStatus): IStatusPickItem {
	const details: string[] = [];

	if (auth.state === LucosAuthState.Authenticated) {
		if (auth.orgId) {
			details.push(localize('lucos.showStatus.accountOrg', "Org: {0}", auth.orgId));
		}
		if (auth.planCode) {
			details.push(localize('lucos.showStatus.accountPlan', "Plan: {0}", auth.planCode));
		}
		if (auth.roles && auth.roles.length > 0) {
			details.push(localize('lucos.showStatus.accountRoles', "Roles: {0}", auth.roles.join(', ')));
		}
		if (typeof auth.tokenExpiresAt === 'number') {
			details.push(localize('lucos.showStatus.accountTokenExpiresAt', "Token Expires: {0}", formatTimestamp(auth.tokenExpiresAt)));
		}
	}

	if (!auth.cloudReachable) {
		details.push(localize('lucos.showStatus.accountCloudUnreachable', "Cloud Unreachable"));
	}

	return {
		label: '$(account) ' + localize('lucos.showStatus.account', "Account"),
		description: describeAuth(auth),
		detail: details.length > 0 ? details.join(' · ') : undefined,
	};
}

function describeIndex(index: ILucosIndexStatus): string {
	switch (index.state) {
		case LucosIndexState.Indexing:
			return localize('lucos.showStatus.indexIndexing', "Indexing…");
		case LucosIndexState.Indexed:
			return localize('lucos.showStatus.indexIndexed', "Indexed · {0} files · {1} chunks", index.filesIndexed ?? 0, index.chunksTotal ?? 0);
		case LucosIndexState.Stale:
			return localize('lucos.showStatus.indexStale', "Stale · {0} file(s) changed", index.staleCount ?? 0);
		case LucosIndexState.Failed:
			return localize('lucos.showStatus.indexFailed', "Failed · {0}", index.message ?? localize('lucos.showStatus.unknown', "unknown error"));
		default:
			return localize('lucos.showStatus.indexIdle', "Not indexed yet");
	}
}

function describeAuth(auth: ILucosAuthStatus): string {
	if (auth.state === LucosAuthState.Authenticated) {
		return auth.userId
			? localize('lucos.showStatus.signedInAs', "Signed in as {0}", auth.userId)
			: localize('lucos.showStatus.signedIn', "Signed in");
	}
	return localize('lucos.showStatus.signedOut', "Signed out");
}

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	if (isNaN(date.getTime())) {
		return localize('lucos.showStatus.unknownTimestamp', "unknown");
	}

	return date.toLocaleString();
}
