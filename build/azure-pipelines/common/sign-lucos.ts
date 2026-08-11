/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-file signing hook called by InnoSetup's `lucos` sign-tool definition.
 *
 * InnoSetup invokes this script for each output file that requires signing:
 *   node build/azure-pipelines/common/sign-lucos.ts <file>
 *
 * The file path is passed as the first positional CLI argument (argv[2]).
 * Exit code 0 = success; non-zero = failure (InnoSetup will abort the build).
 */

import path from 'path';
import { signFile } from '../../lib/signWindows.ts';

const filePath = process.argv[2];
if (!filePath) {
	console.error('[sign-lucos] Usage: node sign-lucos.ts <file>');
	process.exit(1);
}

signFile(path.resolve(filePath))
	.then(() => console.log(`[sign-lucos] Signed: ${filePath}`))
	.catch(err => {
		console.error(`[sign-lucos] Failed to sign "${filePath}": ${err.message}`);
		process.exit(1);
	});
