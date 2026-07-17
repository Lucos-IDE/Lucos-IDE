/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, usePwsh } from 'zx';
import { printBanner, spawnCodesignProcess, streamProcessOutputAndCheckResult } from '../common/codesign.ts';
import { e } from '../common/publish.ts';
import { signDirectory } from '../../lib/signWindows.ts';

async function main() {
	usePwsh();

	const arch = e('VSCODE_ARCH');
	const codeSigningFolderPath = e('CodeSigningFolderPath');

	// Determine signing mode.
	// - ESRP (Microsoft internal): EsrpCliDllPath env var is present.
	// - DigiCert KeyLocker: SM_API_KEY + SM_KEYPAIR_ALIAS (+ client cert) present.
	// - Lucos software PFX: WINDOWS_PFX_DATA + WINDOWS_PFX_PASSWORD present.
	const useEsrp = !!process.env['EsrpCliDllPath'];
	const useKeyLocker = !useEsrp && !!(process.env['SM_API_KEY'] && process.env['SM_KEYPAIR_ALIAS'] && process.env['SM_CLIENT_CERT_FILE']);
	const useLucosPfx = !useEsrp && !useKeyLocker && !!(process.env['WINDOWS_PFX_DATA'] && process.env['WINDOWS_PFX_PASSWORD']);
	const useLucos = useKeyLocker || useLucosPfx;

	if (!useEsrp && !useLucos) {
		throw new Error(
			'No signing credentials found. Set either EsrpCliDllPath (ESRP), ' +
			'DigiCert KeyLocker (SM_API_KEY, SM_CLIENT_CERT_FILE, SM_CLIENT_CERT_PASSWORD, SM_KEYPAIR_ALIAS), ' +
			'or WINDOWS_PFX_DATA + WINDOWS_PFX_PASSWORD.'
		);
	}

	if (useEsrp) {
		const esrpCliDLLPath = e('EsrpCliDllPath');

		// Start the ESRP code-sign processes in parallel:
		// 1. Executables and shared libraries (covers lucos-daemon.exe via *.exe glob)
		// 2. PowerShell scripts
		// 3. Context menu appx package (non-exploration quality only)
		const codesignTask1 = spawnCodesignProcess(esrpCliDLLPath, 'sign-windows', codeSigningFolderPath, '*.dll,*.exe,*.node');
		const codesignTask2 = spawnCodesignProcess(esrpCliDLLPath, 'sign-windows-appx', codeSigningFolderPath, '*.ps1,*.psm1,*.psd1,*.ps1xml');
		const codesignTask3 = process.env['VSCODE_QUALITY'] !== 'exploration'
			? spawnCodesignProcess(esrpCliDLLPath, 'sign-windows-appx', codeSigningFolderPath, '*.appx')
			: undefined;

		printBanner('Codesign executables and shared libraries (ESRP)');
		await streamProcessOutputAndCheckResult('Codesign executables and shared libraries', codesignTask1);

		printBanner('Codesign Powershell scripts (ESRP)');
		await streamProcessOutputAndCheckResult('Codesign Powershell scripts', codesignTask2);

		if (codesignTask3) {
			printBanner('Codesign context menu appx package (ESRP)');
			await streamProcessOutputAndCheckResult('Codesign context menu appx package', codesignTask3);
		}
	} else {
		// Lucos Authenticode path: DigiCert KeyLocker (preferred) or software PFX.
		printBanner(useKeyLocker ? 'Codesign executables (DigiCert KeyLocker)' : 'Codesign executables (Lucos / PFX)');
		await signDirectory(codeSigningFolderPath);
	}

	// Create build artifact directory
	await $`New-Item -ItemType Directory -Path .build/win32-${arch} -Force`;

	// Package client
	if (process.env['BUILT_CLIENT']) {
		printBanner('Package client');
		const clientArchivePath = `.build/win32-${arch}/Lucos-win32-${arch}.zip`;
		await $`7z.exe a -tzip ${clientArchivePath} ../Lucos-win32-${arch}/* "-xr!CodeSignSummary*.md"`.pipe(process.stdout);
		await $`7z.exe l ${clientArchivePath}`.pipe(process.stdout);
	}

	// Package server
	if (process.env['BUILT_SERVER']) {
		printBanner('Package server');
		const serverArchivePath = `.build/win32-${arch}/vscode-server-win32-${arch}.zip`;
		await $`7z.exe a -tzip ${serverArchivePath} ../vscode-server-win32-${arch}`.pipe(process.stdout);
		await $`7z.exe l ${serverArchivePath}`.pipe(process.stdout);
	}

	// Package server (web)
	if (process.env['BUILT_WEB']) {
		printBanner('Package server (web)');
		const webArchivePath = `.build/win32-${arch}/vscode-server-win32-${arch}-web.zip`;
		await $`7z.exe a -tzip ${webArchivePath} ../vscode-server-win32-${arch}-web`.pipe(process.stdout);
		await $`7z.exe l ${webArchivePath}`.pipe(process.stdout);
	}

	// Sign setup
	if (process.env['BUILT_CLIENT']) {
		const signFlag = useEsrp ? '--sign' : '--sign-lucos';
		printBanner(`Sign setup packages (system, user) [${useEsrp ? 'ESRP' : 'Lucos'}]`);
		const task = $`npm exec -- npm-run-all2 -lp "gulp vscode-win32-${arch}-system-setup -- ${signFlag}" "gulp vscode-win32-${arch}-user-setup -- ${signFlag}"`;
		await streamProcessOutputAndCheckResult('Sign setup packages (system, user)', task);
	}
}

main().then(() => {
	process.exit(0);
}, err => {
	console.error(`ERROR: ${err}`);
	process.exit(1);
});
