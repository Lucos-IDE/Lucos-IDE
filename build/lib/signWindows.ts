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
			// Aliases are case-sensitive; trim accidental secret whitespace.
			const alias = requireEnv('SM_KEYPAIR_ALIAS').trim();
			process.env['SM_KEYPAIR_ALIAS'] = alias;

			console.log('[sign-windows] Registering DigiCert KSP…');
			const ksp = await spawnCapture('smctl', ['windows', 'ksp', 'register']);
			const kspOut = `${ksp.stdout}\n${ksp.stderr}`;
			if (ksp.code !== 0) {
				// 0xc0000035 = STATUS_OBJECT_NAME_COLLISION → provider already registered.
				if (/0xc0000035/i.test(kspOut) || /already/i.test(kspOut)) {
					console.log('[sign-windows] DigiCert KSP already registered (ok).');
				} else {
					console.warn(`[sign-windows] KSP register warning (exit ${ksp.code}): ${kspOut.trim()}`);
				}
			}

			console.log('[sign-windows] Listing keypairs visible to this DigiCert identity…');
			const listed = await spawnCapture('smctl', ['keypair', 'list']);
			process.stdout.write(listed.stdout);
			process.stderr.write(listed.stderr);
			if (listed.code !== 0) {
				throw new Error(
					`[sign-windows] smctl keypair list failed (exit ${listed.code}). ` +
					`Check SM_HOST / API key / client cert, and that this DigiCert user is the KeyLocker signer.`
				);
			}
			const listText = `${listed.stdout}\n${listed.stderr}`;
			if (!listText.includes(alias)) {
				throw new Error(
					`[sign-windows] Keypair alias "${alias}" is not visible to this DigiCert identity.\n` +
					`DigiCert KeyLocker allows one designated signer — assign your CI service user as the ` +
					`signer for this certificate in DigiCert ONE → KeyLocker → Certificates, then copy the ` +
					`exact Alias from the Alias column (case-sensitive) into SM_KEYPAIR_ALIAS.\n` +
					`smctl keypair list output is above.`
				);
			}

			const outDir = process.env['RUNNER_TEMP'] || os.tmpdir();
			const certName = 'lucos-codesign';
			console.log(`[sign-windows] Downloading certificate for alias=${alias}…`);
			try {
				await spawnInherit('smctl', [
					'certificate',
					'download',
					`--keypair-alias=${alias}`,
					`--name=${certName}`,
					`--out=${outDir}`,
				]);
			} catch (err) {
				throw new Error(
					`[sign-windows] certificate download failed for alias "${alias}": ` +
					`${err instanceof Error ? err.message : err}\n` +
					`Confirm the exact alias via DigiCert ONE → KeyLocker → Certificates → Alias column.`
				);
			}

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
 * Walks `dir` and signs Lucos product `.exe` files only.
 *
 * Skips third-party binaries under node_modules / vendor trees — those burn
 * DigiCert signature quota and often fail Authenticode (bad PE / wrong arch).
 * InnoSetup still signs the installer via sign-lucos.ts.
 */
export async function signDirectory(dir: string): Promise<void> {
	const files = findProductExeFiles(dir);
	console.log(`[sign-windows] Signing ${files.length} Lucos product exe(s) under ${dir}`);
	for (const f of files) {
		console.log(`[sign-windows] Signing ${f}`);
		await signFile(f);
	}
}

/** True when either KeyLocker or PFX credentials are present. */
export function canSignWindows(): boolean {
	return hasKeyLockerCredentials() || hasPfxCredentials();
}

/**
 * Product binaries we own / ship as Lucos:
 * - root Electron app + helpers (Lucos.exe, Lucos*.exe at app root)
 * - bundled lucos-daemon.exe
 * - Inno updater tools under tools/
 *
 * Does not walk node_modules / extension vendor bins (bad PE formats and
 * DigiCert signature-quota waste).
 */
function findProductExeFiles(root: string): string[] {
	const results: string[] = [];
	const rootResolved = path.resolve(root);

	const addIfExe = (filePath: string): void => {
		if (fs.existsSync(filePath) && /\.exe$/i.test(filePath)) {
			results.push(filePath);
		}
	};

	for (const entry of fs.readdirSync(rootResolved, { withFileTypes: true })) {
		if (entry.isFile() && /\.exe$/i.test(entry.name)) {
			addIfExe(path.join(rootResolved, entry.name));
		}
	}

	addIfExe(path.join(rootResolved, 'resources', 'app', 'resources', 'lucos-daemon.exe'));

	const toolsDir = path.join(rootResolved, 'tools');
	if (fs.existsSync(toolsDir)) {
		for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
			if (entry.isFile()) {
				addIfExe(path.join(toolsDir, entry.name));
			}
		}
	}

	return results;
}
