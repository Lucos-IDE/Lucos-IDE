/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bake Lucos packaging config into product.json / package.json (and settings defaults)
 * before packaging. Used by Lucos Release CI for staging vs production builds.
 *
 * Usage:
 *   LUCOS_GATEWAY_URL=https://api.lucos.com \
 *   LUCOS_GITHUB_RELEASES_TOKEN=ghp_... \
 *   LUCOS_PRODUCT_VERSION=0.1.24 \
 *   node --experimental-strip-types .github/scripts/patch-lucos-gateway.ts
 *
 * LUCOS_PRODUCT_VERSION is optional. When unset, tag refs (refs/tags/vX.Y.Z) are
 * used so About + auto-update compare against GitHub release tags correctly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const gateway = (process.env.LUCOS_GATEWAY_URL || '').trim();
if (!gateway) {
	console.error('LUCOS_GATEWAY_URL is required');
	process.exit(1);
}
if (!/^https:\/\//.test(gateway)) {
	console.error(`LUCOS_GATEWAY_URL must be an https URL, got: ${gateway}`);
	process.exit(1);
}

function resolveProductVersion(): string | undefined {
	const fromEnv = (process.env.LUCOS_PRODUCT_VERSION || '').trim().replace(/^v/, '');
	if (fromEnv) {
		return fromEnv;
	}

	const ref = (process.env.GITHUB_REF || '').trim();
	const tagMatch = /^refs\/tags\/v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(ref);
	if (tagMatch) {
		return tagMatch[1];
	}

	return undefined;
}

const root = process.cwd();
const productPath = path.join(root, 'product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8')) as {
	lucosGatewayUrl?: string;
	gitHubReleasesRepo?: string;
	gitHubReleasesToken?: string;
};
product.lucosGatewayUrl = gateway;

const releasesToken = (process.env.LUCOS_GITHUB_RELEASES_TOKEN || '').trim();
if (releasesToken) {
	product.gitHubReleasesRepo = product.gitHubReleasesRepo || 'Lucos-IDE/Lucos-IDE';
	product.gitHubReleasesToken = releasesToken;
	console.log(`Patched product.json gitHubReleasesToken (repo=${product.gitHubReleasesRepo})`);
} else {
	console.log('LUCOS_GITHUB_RELEASES_TOKEN not set; GitHub Releases auto-update remains disabled (update.lucos.app fallback)');
}

fs.writeFileSync(productPath, `${JSON.stringify(product, null, '\t')}\n`);
console.log(`Patched product.json lucosGatewayUrl -> ${gateway}`);

const productVersion = resolveProductVersion();
if (productVersion) {
	if (!/^\d+\.\d+\.\d+/.test(productVersion)) {
		console.error(`LUCOS_PRODUCT_VERSION must look like major.minor.patch, got: ${productVersion}`);
		process.exit(1);
	}

	const packagePath = path.join(root, 'package.json');
	const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
	const previousVersion = packageJson.version;
	packageJson.version = productVersion;
	fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, '\t')}\n`);
	console.log(`Patched package.json version ${previousVersion} -> ${productVersion}`);
} else {
	console.log('No LUCOS_PRODUCT_VERSION / v* tag; leaving package.json version unchanged');
}

const contribPath = path.join(root, 'src/vs/workbench/contrib/lucos/browser/lucos.contribution.ts');
const contrib = fs.readFileSync(contribPath, 'utf8');
const gatewayDefaultRe = /(\[LucosSettingId\.CloudGatewayUrl\]:\s*\{[\s\S]*?default:\s*)'([^']*)'/;
const match = gatewayDefaultRe.exec(contrib);
if (!match) {
	console.error(`Failed to find CloudGatewayUrl default in ${contribPath}`);
	process.exit(1);
}

const currentDefault = match[2];
if (currentDefault === gateway) {
	console.log(`lucos.contribution.ts CloudGatewayUrl default already ${gateway}`);
} else {
	const next = contrib.replace(gatewayDefaultRe, `$1'${gateway}'`);
	fs.writeFileSync(contribPath, next);
	console.log(`Patched lucos.contribution.ts CloudGatewayUrl default ${currentDefault} -> ${gateway}`);
}
