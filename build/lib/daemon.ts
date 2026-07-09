/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lucos daemon binary bundling helpers.
 *
 * The Go daemon is pre-built per platform/arch by CI and placed under:
 *   .build/daemon/lucos-daemon-<platform>-<arch>[.exe]
 *
 * During the Electron packaging step (packageTask), getDaemonStream() returns a
 * vinyl stream containing the binary renamed to the canonical in-app path:
 *   resources/lucos-daemon          (macOS / Linux)
 *   resources/lucos-daemon.exe      (Windows)
 *
 * Executable bits (mode 0755) are set automatically for macOS and Linux via
 * util.setExecutableBit.
 */

import * as path from 'path';
import * as fs from 'fs';
import vfs from 'vinyl-fs';
import { rename } from './gulp/facade.ts';
import * as util from './util.ts';

const root = path.join(import.meta.dirname, '..', '..');

/** Binary file name inside `.build/daemon/` for a given platform/arch. */
export function getDaemonBinaryName(platform: string, arch: string): string {
	const ext = platform === 'win32' ? '.exe' : '';
	return `lucos-daemon-${platform}-${arch}${ext}`;
}

/** Canonical in-app resource path for the daemon binary. */
export function getDaemonResourceName(platform: string): string {
	return platform === 'win32' ? 'lucos-daemon.exe' : 'lucos-daemon';
}

/**
 * Returns a vinyl stream for the daemon binary, renamed to its in-app path
 * (`resources/lucos-daemon[.exe]`).  Returns null when the binary is absent
 * (e.g. local dev builds that haven't run the Go build step).
 */
export function getDaemonStream(platform: string, arch: string): NodeJS.ReadableStream | null {
	const binaryName = getDaemonBinaryName(platform, arch);
	const binaryPath = path.join(root, '.build', 'daemon', binaryName);

	if (!fs.existsSync(binaryPath)) {
		console.warn(`[daemon] Binary not found, skipping: ${binaryPath}`);
		return null;
	}

	const resourceName = getDaemonResourceName(platform);
	const stream = vfs.src(binaryPath, { base: path.dirname(binaryPath) })
		.pipe(rename(() => ({ dirname: 'resources', basename: path.parse(resourceName).name, extname: path.parse(resourceName).ext })));

	// Set executable bit on non-Windows platforms.
	if (platform !== 'win32') {
		return stream.pipe(util.setExecutableBit('**/lucos-daemon'));
	}

	return stream;
}
