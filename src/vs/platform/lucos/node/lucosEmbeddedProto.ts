/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { FileAccess } from '../../../base/common/network.js';

/**
 * Trimmed proto subset the IDE gRPC client materialises at runtime
 * (aligned with local-daemon/proto/lucos/v1/agent.proto).
 *
 * Must use FileAccess (not import.meta.url): the client is bundled into
 * out/main.js, so dirname(import.meta.url) is out/ and would miss the
 * packaged resource under out/vs/platform/lucos/node/.
 */
const protoPath = FileAccess.asFileUri('vs/platform/lucos/node/lucosDaemon.embedded.proto').fsPath;
export const LUCOS_IDE_EMBEDDED_PROTO = readFileSync(protoPath, 'utf8');
