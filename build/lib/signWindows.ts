/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Authenticode signing helpers for the Lucos build pipeline.
 *
 * Reads a base64-encoded PFX bundle and its passphrase from CI environment
 * variables, writes the certificate to a private temp file, invokes
 * signtool.exe, then deletes the temp cert.
 *
 * Required CI secrets (environment variables):
 *   WINDOWS_PFX_DATA      Base64-encoded PFX / PKCS#12 certificate bundle.
 *   WINDOWS_PFX_PASSWORD  Passphrase protecting the PFX.
 *
 * Both variables must be present; missing ones throw at call time so the build
 * fails loudly rather than producing an unsigned artifact.
 */

import cp from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** RFC 3161 timestamp server. DigiCert is publicly accessible and reliable. */
const TIMESTAMP_SERVER = 'http://timestamp.digicert.com';

function requireEnv(name: string): string {
	const val = process.env[name];
	if (!val) {
		throw new Error(`[sign-windows] Required environment variable "${name}" is not set.`);
	}
	return val;
}

/**
 * Signs a single Windows PE binary using signtool.exe.
 *
 * Applies:
 *  - SHA-256 primary file digest   (/fd sha256)
 *  - RFC-3161 counter-signature    (/tr … /td sha256)
 *
 * The PFX is decoded from WINDOWS_PFX_DATA (base64) and written to a
 * temporary file with mode 0o600.  The file is deleted whether signing
 * succeeds or fails.
 */
export async function signFile(filePath: string): Promise<void> {
	const pfxBase64 = requireEnv('WINDOWS_PFX_DATA');
	const pfxPassword = requireEnv('WINDOWS_PFX_PASSWORD');

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucos-sign-'));
	const pfxPath = path.join(tmpDir, `${crypto.randomBytes(8).toString('hex')}.pfx`);

	function cleanup(): void {
		try { fs.unlinkSync(pfxPath); } catch { /* already gone */ }
		try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
	}

	try {
		fs.writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'), { mode: 0o600 });
	} catch (err) {
		cleanup();
		throw err;
	}

	await new Promise<void>((resolve, reject) => {
		const args = [
			'sign',
			'/fd', 'sha256',
			'/td', 'sha256',
			'/tr', TIMESTAMP_SERVER,
			'/f', pfxPath,
			'/p', pfxPassword,
			filePath,
		];

		cp.spawn('signtool.exe', args, { stdio: 'inherit' })
			.on('error', err => { cleanup(); reject(err); })
			.on('exit', code => {
				cleanup();
				code === 0
					? resolve()
					: reject(new Error(`signtool.exe exited with code ${code} signing "${path.basename(filePath)}"`));
			});
	});
}

/**
 * Walks `dir` recursively and signs every .exe file found.
 *
 * Used in the pre-package codesign step to sign Electron binaries and
 * lucos-daemon.exe before InnoSetup packages them into the installer.
 */
export async function signDirectory(dir: string): Promise<void> {
	for (const f of findExeFiles(dir)) {
		console.log(`[sign-windows] Signing ${f}`);
		await signFile(f);
	}
}

function findExeFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...findExeFiles(full));
		} else if (/\.exe$/i.test(entry.name)) {
			results.push(full);
		}
	}
	return results;
}
