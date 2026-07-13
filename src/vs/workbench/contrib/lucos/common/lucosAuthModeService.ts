/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lucos IDE - auth mode / cloud feature-gating service (TW-178 / TW-197).
// Single source of truth for whether cloud features (LLM, semantic search, cloud indexing)
// are enabled. Reads `lucos.auth.mode` from settings; local-only mode never blocks the editor.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

export const ILucosAuthModeService = createDecorator<ILucosAuthModeService>('lucosAuthModeService');

export interface ILucosAuthModeService {
	readonly _serviceBrand: undefined;

	/** True when `lucos.auth.mode` is `'local-only'`. */
	readonly isLocalOnly: boolean;

	/** Fires whenever `isLocalOnly` changes (user edits the setting). */
	readonly onDidChangeMode: Event<boolean>;

	/**
	 * Gate a cloud-dependent feature.
	 *
	 * Returns `true` if cloud features are available (mode is `'cloud'`).
	 * If `local-only`, shows an informational notification explaining how to enable cloud
	 * features and returns `false`. The caller should bail out without blocking the editor.
	 */
	requireCloud(notificationService: INotificationService): boolean;
}
