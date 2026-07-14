/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const LUCOS_VIEW_CONTAINER_ID = 'workbench.view.lucos';
export const LUCOS_CHAT_VIEW_ID = 'lucos.chatView';
export const LUCOS_FOCUS_CHAT_COMMAND_ID = 'lucos.focusAIChat';

/** True when the user is NOT signed in to Lucos. Controls the title bar Sign In button. */
export const LUCOS_SIGNED_OUT_CONTEXT = new RawContextKey<boolean>('lucosSignedOut', true);
