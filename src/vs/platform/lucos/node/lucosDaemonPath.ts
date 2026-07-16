/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { dirname, join } from '../../../base/common/path.js';

export interface ILucosDaemonPathOptions {
	/** Absolute path to the packaged app root (`…/Resources/app`). */
	readonly appRoot: string;
	/** When false (dev/`VSCODE_DEV`), never resolve a bundled binary. */
	readonly isBuilt: boolean;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
}

/**
 * Resolves the packaged Lucos daemon binary path.
 *
 * Prefer the canonical layout from packaging (`app/resources/lucos-daemon[.exe]`),
 * then fall back to the legacy staged name and the doc-preferred sibling path.
 * Returns `undefined` for unpackaged/dev builds.
 */
export function resolveLucosDaemonBinaryPath(options: ILucosDaemonPathOptions): string | undefined {
	if (!options.isBuilt) {
		return undefined;
	}

	const platform = options.platform ?? process.platform;
	const arch = normalizeArch(options.arch ?? process.arch);
	const ext = platform === 'win32' ? '.exe' : '';
	const appRoot = options.appRoot;

	const candidates = [
		join(appRoot, 'resources', `lucos-daemon${ext}`),
		join(appRoot, `lucos-daemon-${platform}-${arch}${ext}`),
		// Data-flow doc layout: Contents/Resources/lucos-daemon (sibling of app/)
		join(dirname(appRoot), `lucos-daemon${ext}`),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	return undefined;
}

function normalizeArch(arch: string): string {
	switch (arch) {
		case 'x86_64':
		case 'amd64':
			return 'x64';
		case 'aarch64':
			return 'arm64';
		default:
			return arch;
	}
}
