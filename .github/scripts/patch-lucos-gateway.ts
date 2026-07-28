/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bake the Lucos cloud gateway URL into product.json and the settings default
 * before packaging. Used by Lucos Release CI for staging vs production builds.
 *
 * Usage: LUCOS_GATEWAY_URL=https://api.lucos.com node --experimental-strip-types .github/scripts/patch-lucos-gateway.ts
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

const root = process.cwd();
const productPath = path.join(root, 'product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf8')) as { lucosGatewayUrl?: string };
product.lucosGatewayUrl = gateway;
fs.writeFileSync(productPath, `${JSON.stringify(product, null, '\t')}\n`);
console.log(`Patched product.json lucosGatewayUrl -> ${gateway}`);

const contribPath = path.join(root, 'src/vs/workbench/contrib/lucos/browser/lucos.contribution.ts');
const contrib = fs.readFileSync(contribPath, 'utf8');
const next = contrib.replace(
	/(\[LucosSettingId\.CloudGatewayUrl\]:\s*\{[\s\S]*?default:\s*)'[^']*'/,
	`$1'${gateway}'`,
);
if (next === contrib) {
	console.error(`Failed to patch CloudGatewayUrl default in ${contribPath}`);
	process.exit(1);
}
fs.writeFileSync(contribPath, next);
console.log(`Patched lucos.contribution.ts CloudGatewayUrl default -> ${gateway}`);
