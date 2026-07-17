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
 *    Signs with Microsoft signtool + DigiCert KSP (works for .exe and InnoSetup .e32.tmp PEs).
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

/** DigiCert KeyLocker / Software Trust Manager CNG provider name. */
const DIGICERT_KSP = 'DigiCert Signing Manager KSP';

let keyLockerReady: Promise<string> | undefined;

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

function spawnCapture(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = cp.spawn(command, args, { env: process.env, shell: false });
		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
		child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
		child.on('error', reject);
		child.on('exit', code => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

function findSignTool(): string {
	const fromEnv = process.env['SIGNTOOL_PATH'];
	if (fromEnv && fs.existsSync(fromEnv)) {
		return fromEnv;
	}

	const which = cp.spawnSync('where.exe', ['signtool.exe'], { encoding: 'utf8' });
	if (which.status === 0) {
		const first = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
		if (first && fs.existsSync(first)) {
			return first;
		}
	}

	const kitsRoot = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
	if (fs.existsSync(kitsRoot)) {
		const versions = fs.readdirSync(kitsRoot).sort().reverse();
		for (const ver of versions) {
			const candidate = path.join(kitsRoot, ver, 'x64', 'signtool.exe');
			if (fs.existsSync(candidate)) {
				return candidate;
			}
		}
	}

	throw new Error('[sign-windows] signtool.exe not found (install Windows SDK or set SIGNTOOL_PATH)');
}

/**
 * One-time KeyLocker prep: register KSP and download the public code-signing cert for /f.
 * Returns absolute path to the certificate file (.crt / .pem).
 */
async function ensureKeyLockerCertificate(): Promise<string> {
	if (process.env['SM_CODE_SIGNING_CERT'] && fs.existsSync(process.env['SM_CODE_SIGNING_CERT'])) {
		return process.env['SM_CODE_SIGNING_CERT'];
	}

	if (!keyLockerReady) {
		keyLockerReady = (async () => {
			if (!process.env['SM_HOST']) {
				process.env['SM_HOST'] = 'https://clientauth.one.digicert.com';
			}
			const alias = requireEnv('SM_KEYPAIR_ALIAS');

			console.log('[sign-windows] Registering DigiCert KSP…');
			try {
				await spawnInherit('smctl', ['windows', 'ksp', 'register']);
			} catch (err) {
				// Already registered is fine; continue and let signing fail loudly if broken.
				console.warn(`[sign-windows] KSP register warning: ${err instanceof Error ? err.message : err}`);
			}

			const outDir = process.env['RUNNER_TEMP'] || os.tmpdir();
			const certName = 'lucos-codesign';
			console.log(`[sign-windows] Downloading certificate for alias=${alias}…`);
			await spawnInherit('smctl', [
				'certificate',
				'download',
				`--keypair-alias=${alias}`,
				`--name=${certName}`,
				`--out=${outDir}`,
			]);

			const candidates = [
				path.join(outDir, `${certName}.crt`),
				path.join(outDir, `${certName}.pem`),
				path.join(outDir, `${certName}.cer`),
				path.join(outDir, certName),
			];
			const certPath = candidates.find(p => fs.existsSync(p));
			if (!certPath) {
				const listing = fs.existsSync(outDir) ? fs.readdirSync(outDir).join(', ') : '(missing dir)';
				throw new Error(`[sign-windows] Certificate download succeeded but file not found in ${outDir}. Contents: ${listing}`);
			}

			process.env['SM_CODE_SIGNING_CERT'] = certPath;
			console.log(`[sign-windows] Using certificate ${certPath}`);
			return certPath;
		})();
	}

	return keyLockerReady;
}

async function verifySigned(signTool: string, filePath: string): Promise<void> {
	const result = await spawnCapture(signTool, ['verify', '/pa', filePath]);
	if (result.code !== 0) {
		throw new Error(
			`[sign-windows] Signature verification failed for ${path.basename(filePath)}:\n` +
			`${result.stdout}\n${result.stderr}`
		);
	}
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
 * Sign via DigiCert KeyLocker using Microsoft signtool + DigiCert KSP.
 *
 * Note: plain `smctl sign` (simple mode) skips non-standard PE extensions such as
 * InnoSetup's `.e32.tmp`, exiting 0 with "no files found". Signtool Authenticode
 * is required for those installer staging binaries.
 */
async function signFileWithKeyLocker(filePath: string): Promise<void> {
	const alias = requireEnv('SM_KEYPAIR_ALIAS');
	const certPath = await ensureKeyLockerCertificate();
	const signTool = findSignTool();

	console.log(`[sign-windows] KeyLocker/signtool signing ${path.basename(filePath)} (alias=${alias})`);
	await spawnInherit(signTool, [
		'sign',
		'/csp', DIGICERT_KSP,
		'/kc', alias,
		'/f', certPath,
		'/fd', 'sha256',
		'/td', 'sha256',
		'/tr', TIMESTAMP_SERVER,
		filePath,
	]);
	await verifySigned(signTool, filePath);
}

/**
 * Sign via classic Authenticode PFX with signtool.exe.
 */
async function signFileWithPfx(filePath: string): Promise<void> {
	const pfxBase64 = requireEnv('WINDOWS_PFX_DATA');
	const pfxPassword = requireEnv('WINDOWS_PFX_PASSWORD');
	const signTool = findSignTool();

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
		await spawnInherit(signTool, [
			'sign',
			'/fd', 'sha256',
			'/td', 'sha256',
			'/tr', TIMESTAMP_SERVER,
			'/f', pfxPath,
			'/p', pfxPassword,
			filePath,
		]);
		await verifySigned(signTool, filePath);
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
