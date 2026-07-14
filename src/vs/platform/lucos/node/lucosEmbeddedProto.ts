/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'fs';
import { dirname, join } from '../../../base/common/path.js';
import { fileURLToPath } from 'url';

/** Trimmed proto subset the IDE gRPC client materialises at runtime (aligned with local-daemon/proto/lucos/v1/agent.proto). */
const protoPath = join(dirname(fileURLToPath(import.meta.url)), 'lucosDaemon.embedded.proto');
export const LUCOS_IDE_EMBEDDED_PROTO = readFileSync(protoPath, 'utf8');
