/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Lucos IDE - workspace indexing state (TW-220 / TW-169 / TW-170).
// Owns the IDE-facing index status derived from the daemon's `index.*` event stream, so the
// status bar and notifications read a single source of truth and the command just triggers it.

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILucosIndexStatus } from '../../../../platform/lucos/common/lucosProtocol.js';

export const ILucosIndexService = createDecorator<ILucosIndexService>('lucosIndexService');

export interface ILucosIndexService {
	readonly _serviceBrand: undefined;

	readonly status: ILucosIndexStatus;
	readonly onDidChangeStatus: Event<ILucosIndexStatus>;

	/** (Re)index the active workspace via the daemon. `force` bypasses the cache (full rescan). */
	index(force?: boolean): Promise<void>;
}
