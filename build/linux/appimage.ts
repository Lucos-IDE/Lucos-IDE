/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lucos AppImage builder.
 *
 * Converts the compiled VSCode-linux-<arch> app directory into a self-contained,
 * portable AppImage that runs on any glibc-based Linux distribution (x86_64 or
 * aarch64) without system installation.
 *
 * AppImage execution modes (both are always available):
 *   - FUSE mount  — transparent, requires libfuse2 on the host
 *   - Extract-and-run  — `--appimage-extract-and-run` flag, no FUSE dependency
 *
 * The Lucos daemon binary (lucos-daemon) is bundled inside the AppImage as
 * `resources/lucos-daemon` by the upstream `packageTask` in gulpfile.vscode.ts
 * before this script is called; this script validates its presence.
 *
 * Environment variables
 *   VSCODE_ARCH         — target arch: `x64` (default) or `arm64`
 *   GPG_KEY_ID          — if set, detach-signs the AppImage with `gpg --armor`
 *   APPIMAGE_TOOL_PATH  — override path to appimagetool binary (skips download)
 *
 * Exported surface
 *   buildAppImage(arch, outDir)  — produces the .AppImage file, returns its path
 *   gpgSign(filePath, keyId)     — creates a detached GPG signature (.asc)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import * as cp from 'child_process';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import product from '../../product.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };

const exec = promisify(cp.exec);
const root = path.join(import.meta.dirname, '..', '..');

// -- appimagetool download -----------------------------------------------------

const APPIMAGETOOL_BASE =
	'https://github.com/AppImage/AppImageKit/releases/download/continuous';

const APPIMAGETOOL_FILENAMES: Record<string, string> = {
	x64: 'appimagetool-x86_64.AppImage',
	arm64: 'appimagetool-aarch64.AppImage',
};

function appimagetoolUrl(arch: string): string {
	const filename = APPIMAGETOOL_FILENAMES[arch];
	if (!filename) {
		throw new Error(`No appimagetool binary available for arch '${arch}'.`);
	}
	return `${APPIMAGETOOL_BASE}/${filename}`;
}

/**
 * Downloads a file over HTTPS, following up to 5 redirects.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
	console.log(`[appimage] Downloading -> ${dest}`);
	await fs.promises.mkdir(path.dirname(dest), { recursive: true });

	return new Promise((resolve, reject) => {
		let redirectsRemaining = 5;

		const attempt = (currentUrl: string): void => {
			const lib = currentUrl.startsWith('https') ? https : http;
			lib
				.get(currentUrl, res => {
					if (
						(res.statusCode === 301 || res.statusCode === 302) &&
						res.headers.location &&
						redirectsRemaining-- > 0
					) {
						return attempt(res.headers.location);
					}
					if (res.statusCode !== 200) {
						return reject(
							new Error(`HTTP ${res.statusCode} while fetching ${currentUrl}`)
						);
					}
					const file = fs.createWriteStream(dest);
					res.pipe(file);
					file.on('finish', () => file.close(err => (err ? reject(err) : resolve())));
					file.on('error', reject);
				})
				.on('error', reject);
		};

		attempt(url);
	});
}

/**
 * Returns the path to appimagetool, downloading it into `.build/tools/` if
 * it is not already cached.  The environment variable `APPIMAGE_TOOL_PATH`
 * overrides the automatic download.
 */
async function ensureAppimagetool(arch: string): Promise<string> {
	const override = process.env['APPIMAGE_TOOL_PATH'];
	if (override) {
		if (!fs.existsSync(override)) {
			throw new Error(
				`APPIMAGE_TOOL_PATH is set but the file does not exist: ${override}`
			);
		}
		return override;
	}

	const toolsDir = path.join(root, '.build', 'tools');
	const toolPath = path.join(toolsDir, APPIMAGETOOL_FILENAMES[arch]);

	if (!fs.existsSync(toolPath)) {
		await downloadFile(appimagetoolUrl(arch), toolPath);
		fs.chmodSync(toolPath, 0o755);
	}

	return toolPath;
}

// -- AppDir metadata helpers ---------------------------------------------------

/**
 * Writes the `AppRun` launcher script that appimagetool sets as the entry
 * point.  The script simply exec's the main binary, passing all arguments
 * through so that CLI flags such as `--new-window` still work.
 */
function writeAppRun(appDir: string): void {
	const appRunPath = path.join(appDir, 'AppRun');
	const appId = product.applicationName;
	// $APPDIR is set by the AppImage runtime to the mount/extraction point.
	const content =
		'#!/bin/sh\n' +
		'exec "${APPDIR:=$(dirname "$0")}/' +
		appId +
		'" "$@"\n';
	fs.writeFileSync(appRunPath, content, { mode: 0o755 });
	console.log(`[appimage] AppRun -> ${appRunPath}`);
}

/**
 * Writes a minimal `.desktop` file at the AppDir root.  appimagetool requires
 * exactly one `.desktop` file at the root (not inside `usr/share/applications/`).
 */
function writeDesktopEntry(appDir: string): void {
	const appId = product.applicationName;
	const destPath = path.join(appDir, `${appId}.desktop`);

	const lines = [
		'[Desktop Entry]',
		`Name=${product.nameLong}`,
		'Comment=Code Editing. Redefined.',
		'GenericName=Text Editor',
		`Exec=${appId} %F`,
		`Icon=${appId}`,
		'Type=Application',
		'StartupNotify=false',
		`StartupWMClass=${product.nameShort}`,
		'Categories=TextEditor;Development;IDE;',
		`MimeType=application/x-${appId}-workspace;`,
		'Actions=new-empty-window;',
		'',
		'[Desktop Action new-empty-window]',
		'Name=New Empty Window',
		`Exec=${appId} --new-window %F`,
		`Icon=${appId}`,
		'',
	];

	fs.writeFileSync(destPath, lines.join('\n'));
	console.log(`[appimage] .desktop -> ${destPath}`);
}

/**
 * Copies the Lucos icon into the AppDir root.  appimagetool identifies the
 * icon by matching the `.desktop` `Icon=` field to a file `<Icon>.png` (or
 * .svg / .xpm) at the root.
 */
function copyIcon(appDir: string): void {
	const appId = product.applicationName;
	const src = path.join(root, 'resources', 'linux', 'code.png');
	const dest = path.join(appDir, `${appId}.png`);
	if (!fs.existsSync(src)) {
		throw new Error(`Linux icon not found: ${src}`);
	}
	fs.copyFileSync(src, dest);
	console.log(`[appimage] icon -> ${dest}`);
}

// -- Main builder --------------------------------------------------------------

/**
 * Builds the AppImage from the `VSCode-linux-<arch>` directory that was
 * produced by `npm run gulp vscode-linux-<arch>-min-ci`.
 *
 * @param arch    Target architecture: `'x64'` or `'arm64'`.
 * @param outDir  Directory that will receive the `.AppImage` file.
 * @returns       Absolute path of the produced `.AppImage` file.
 */
export async function buildAppImage(arch: string, outDir: string): Promise<string> {
	const appDir = path.join(path.dirname(root), `VSCode-linux-${arch}`);

	if (!fs.existsSync(appDir)) {
		throw new Error(
			`App directory not found: ${appDir}\n` +
			`Run 'npm run gulp vscode-linux-${arch}-min-ci' before building the AppImage.`
		);
	}

	// -- Daemon presence check -------------------------------------------------
	const daemonPath = path.join(appDir, 'resources', 'lucos-daemon');
	if (fs.existsSync(daemonPath)) {
		console.log(`[appimage] lucos-daemon ✓`);
	} else {
		// Non-fatal: local dev builds may omit the daemon.  CI always has it.
		console.warn(
			`[appimage] Warning: lucos-daemon not found at ${daemonPath}.\n` +
			`  Ensure .build/daemon/lucos-daemon-linux-${arch} exists before CI packaging.`
		);
	}

	// -- Populate AppDir metadata ----------------------------------------------
	writeAppRun(appDir);
	writeDesktopEntry(appDir);
	copyIcon(appDir);

	// -- Output path -----------------------------------------------------------
	await fs.promises.mkdir(outDir, { recursive: true });
	const appImageName = `Lucos-${packageJson.version}-linux-${arch}.AppImage`;
	const appImagePath = path.join(outDir, appImageName);
	if (fs.existsSync(appImagePath)) {
		fs.unlinkSync(appImagePath);
	}

	// -- Run appimagetool ------------------------------------------------------
	const toolPath = await ensureAppimagetool(arch);
	// ARCH is the ELF architecture tag appimagetool embeds in the runtime.
	const appimageArch = arch === 'x64' ? 'x86_64' : 'aarch64';

	console.log(`[appimage] Building ${appImageName}…`);

	// --appimage-extract-and-run: run appimagetool itself without FUSE
	// (the produced AppImage supports both FUSE mount and extract-and-run)
	await exec(
		`"${toolPath}" --appimage-extract-and-run "${appDir}" "${appImagePath}"`,
		{ env: { ...process.env, ARCH: appimageArch } }
	);

	const stats = fs.statSync(appImagePath);
	const mb = (stats.size / 1024 / 1024).toFixed(1);
	console.log(`[appimage] ${appImagePath} (${mb} MB)`);

	return appImagePath;
}

/**
 * Creates a detached, ASCII-armored GPG signature for `filePath`.
 *
 * The signature is written alongside the original file as `<file>.asc`.
 * Requires `gpg` on `$PATH` and the key to be available in the agent's
 * keyring (typically via `gpg --import` from the `GPG_PRIVATE_KEY` secret
 * before this step runs).
 *
 * @param filePath   Absolute path of the file to sign.
 * @param keyId      Key ID / fingerprint / email for the `-u` argument.
 */
export async function gpgSign(filePath: string, keyId: string): Promise<void> {
	const sigPath = `${filePath}.asc`;
	if (fs.existsSync(sigPath)) {
		fs.unlinkSync(sigPath);
	}
	console.log(`[appimage] GPG-signing with key ${keyId}…`);
	await exec(
		`gpg --batch --yes --detach-sign --armor -u "${keyId}" "${filePath}"`
	);
	console.log(`[appimage] Signature -> ${sigPath}`);
}

// -- CLI entry point -----------------------------------------------------------

async function main(): Promise<void> {
	const arch = process.env['VSCODE_ARCH'] ?? 'x64';
	const outDir = path.join(root, '.build', 'linux', 'appimage');

	const appImagePath = await buildAppImage(arch, outDir);

	const gpgKeyId = process.env['GPG_KEY_ID'];
	if (gpgKeyId) {
		await gpgSign(appImagePath, gpgKeyId);
	} else {
		console.log('[appimage] GPG_KEY_ID not set — skipping signature.');
	}

	// Emit output path in a machine-readable line so CI steps can capture it.
	console.log(`\nAPPIMAGE_OUTPUT=${appImagePath}`);
}

// Run main() when invoked directly (e.g. `node build/linux/appimage.ts`)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
