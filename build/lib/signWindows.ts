/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Authenticode signing helpers for the Lucos build pipeline.
 *
 * Supports two credential modes (checked in order):
 *
 * 1) DigiCert KeyLocker (preferred for CI):
 *    SM_HOST, SM_API_KEY, SM_CLIENT_CERT_FILE, SM_CLIENT_CERT_PASSWORD, SM_KEYPAIR_ALIAS
 *    Requires DigiCert client tools (`smctl`) on PATH (install via DigiCert GitHub Action).
 *
 * 2) Classic software PFX (legacy / local):
 *    WINDOWS_PFX_DATA (base64), WINDOWS_PFX_PASSWORD
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

function hasKeyLockerCredentials(): boolean {
	return !!(
		process.env['SM_API_KEY'] &&
		process.env['SM_CLIENT_CERT_FILE'] &&
		process.env['SM_CLIENT_CERT_PASSWORD'] &&
		process.env['SM_KEYPAIR_ALIAS']
	);
}

function hasPfxCredentials(): boolean {
	return !!(process.env['WINDOWS_PFX_DATA'] && process.env['WINDOWS_PFX_PASSWORD']);
}

function spawnInherit(command: string, args: string[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		cp.spawn(command, args, { stdio: 'inherit', env: process.env, shell: false })
			.on('error', reject)
			.on('exit', code => {
				code === 0
					? resolve()
					: reject(new Error(`${command} exited with code ${code} (${args.join(' ')})`));
			});
	});
}

/**
 * Signs a single Windows PE binary.
 * Prefers DigiCert KeyLocker when configured; otherwise uses a software PFX.
 */
export async function signFile(filePath: string): Promise<void> {
	if (hasKeyLockerCredentials()) {
		await signFileWithKeyLocker(filePath);
		return;
	}
	if (hasPfxCredentials()) {
		await signFileWithPfx(filePath);
		return;
	}
	throw new Error(
		'[sign-windows] No signing credentials. Set DigiCert KeyLocker env ' +
		'(SM_API_KEY, SM_CLIENT_CERT_FILE, SM_CLIENT_CERT_PASSWORD, SM_KEYPAIR_ALIAS) ' +
		'or WINDOWS_PFX_DATA + WINDOWS_PFX_PASSWORD.'
	);
}

/**
 * Sign via DigiCert KeyLocker using `smctl sign` (hash-based; private key never leaves HSM).
 */
async function signFileWithKeyLocker(filePath: string): Promise<void> {
	const alias = requireEnv('SM_KEYPAIR_ALIAS');
	if (!process.env['SM_HOST']) {
		process.env['SM_HOST'] = 'https://clientauth.one.digicert.com';
	}

	console.log(`[sign-windows] KeyLocker signing ${path.basename(filePath)} (alias=${alias})`);
	await spawnInherit('smctl', [
		'sign',
		`--keypair-alias=${alias}`,
		`--input=${filePath}`,
		`--verbose`,
	]);
}

/**
 * Sign via classic Authenticode PFX with signtool.exe.
 */
async function signFileWithPfx(filePath: string): Promise<void> {
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

	try {
		await spawnInherit('signtool.exe', [
			'sign',
			'/fd', 'sha256',
			'/td', 'sha256',
			'/tr', TIMESTAMP_SERVER,
			'/f', pfxPath,
			'/p', pfxPassword,
			filePath,
		]);
	} finally {
		cleanup();
	}
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

/** True when either KeyLocker or PFX credentials are present. */
export function canSignWindows(): boolean {
	return hasKeyLockerCredentials() || hasPfxCredentials();
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
