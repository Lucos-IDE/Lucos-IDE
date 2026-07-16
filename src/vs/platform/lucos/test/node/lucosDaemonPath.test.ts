/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { resolveLucosDaemonBinaryPath } from '../../node/lucosDaemonPath.js';

suite('resolveLucosDaemonBinaryPath', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'lucos-daemon-path-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('returns undefined when not built', () => {
		const appRoot = join(root, 'app');
		mkdirSync(join(appRoot, 'resources'), { recursive: true });
		writeFileSync(join(appRoot, 'resources', 'lucos-daemon'), 'x');
		assert.strictEqual(resolveLucosDaemonBinaryPath({ appRoot, isBuilt: false, platform: 'darwin', arch: 'arm64' }), undefined);
	});

	test('prefers canonical resources/lucos-daemon', () => {
		const appRoot = join(root, 'app');
		mkdirSync(join(appRoot, 'resources'), { recursive: true });
		const canonical = join(appRoot, 'resources', 'lucos-daemon');
		const fallback = join(appRoot, 'lucos-daemon-darwin-arm64');
		writeFileSync(canonical, 'canonical');
		writeFileSync(fallback, 'fallback');
		assert.strictEqual(
			resolveLucosDaemonBinaryPath({ appRoot, isBuilt: true, platform: 'darwin', arch: 'arm64' }),
			canonical,
		);
	});

	test('falls back to staged platform-arch name', () => {
		const appRoot = join(root, 'app');
		mkdirSync(appRoot, { recursive: true });
		const fallback = join(appRoot, 'lucos-daemon-darwin-arm64');
		writeFileSync(fallback, 'fallback');
		assert.strictEqual(
			resolveLucosDaemonBinaryPath({ appRoot, isBuilt: true, platform: 'darwin', arch: 'arm64' }),
			fallback,
		);
	});

	test('falls back to sibling Resources/lucos-daemon', () => {
		const resources = join(root, 'Contents', 'Resources');
		const appRoot = join(resources, 'app');
		mkdirSync(appRoot, { recursive: true });
		const sibling = join(resources, 'lucos-daemon');
		writeFileSync(sibling, 'sibling');
		assert.strictEqual(
			resolveLucosDaemonBinaryPath({ appRoot, isBuilt: true, platform: 'darwin', arch: 'arm64' }),
			sibling,
		);
	});

	test('uses .exe on win32', () => {
		const appRoot = join(root, 'app');
		mkdirSync(join(appRoot, 'resources'), { recursive: true });
		const canonical = join(appRoot, 'resources', 'lucos-daemon.exe');
		writeFileSync(canonical, 'win');
		assert.strictEqual(
			resolveLucosDaemonBinaryPath({ appRoot, isBuilt: true, platform: 'win32', arch: 'x64' }),
			canonical,
		);
	});

	test('returns undefined when missing', () => {
		const appRoot = join(root, 'app');
		mkdirSync(appRoot, { recursive: true });
		assert.strictEqual(
			resolveLucosDaemonBinaryPath({ appRoot, isBuilt: true, platform: 'linux', arch: 'x64' }),
			undefined,
		);
	});
});
