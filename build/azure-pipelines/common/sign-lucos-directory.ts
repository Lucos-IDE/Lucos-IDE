/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sign all .exe files under a directory (Lucos KeyLocker / PFX Authenticode).
 *
 * Usage:
 *   node build/azure-pipelines/common/sign-lucos-directory.ts <dir>
 */

import path from 'path';
import { signDirectory } from '../../lib/signWindows.ts';

const dir = process.argv[2];
if (!dir) {
	console.error('[sign-lucos-directory] Usage: node sign-lucos-directory.ts <dir>');
	process.exit(1);
}

signDirectory(path.resolve(dir))
	.then(() => console.log(`[sign-lucos-directory] Done: ${dir}`))
	.catch(err => {
		console.error(`[sign-lucos-directory] Failed: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
