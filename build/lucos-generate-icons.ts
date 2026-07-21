/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lucos Icon Generator
 * Generates all icon assets from the Lucos </> SVG source.
 * Run with: npx tsx build/lucos-generate-icons.ts
 */

import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const ROOT = join(__dirname, '..');
const ICONS_MODULES = join(ROOT, '%TEMP%/lucos-icons/node_modules');

interface SharpInstance {
	resize(w: number, h: number): SharpInstance;
	png(): SharpInstance;
	toBuffer(): Promise<Buffer>;
}
interface SharpFn {
	(input: Buffer): SharpInstance;
}
interface PngToIcoModule {
	default?: (pngs: Buffer[]) => Promise<Buffer>;
	imagesToIco?: (pngs: Buffer[]) => Promise<Buffer>;
}

const sharp = _require(join(ICONS_MODULES, 'sharp')) as SharpFn;
const pngToIcoMod = _require(join(ICONS_MODULES, 'png-to-ico')) as PngToIcoModule;
const pngToIco = (pngToIcoMod.default ?? pngToIcoMod.imagesToIco)!;

// The Lucos </> icon: code brackets on a black rounded-rectangle background,
// matching the existing linux/code.png and win32/144x144.png assets.
const LUCOS_ICON_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
	'<defs>',
	'<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">',
	'<stop offset="0%" stop-color="#4EC3F8"/>',
	'<stop offset="50%" stop-color="#6B9EF0"/>',
	'<stop offset="100%" stop-color="#8B7DE8"/>',
	'</linearGradient>',
	'</defs>',
	'<rect width="400" height="400" rx="90" ry="90" fill="#0A0A0A"/>',
	'<polyline points="148,136 96,200 148,264" fill="none" stroke="url(#g)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>',
	'<line x1="228" y1="126" x2="172" y2="274" stroke="url(#g)" stroke-width="24" stroke-linecap="round"/>',
	'<polyline points="252,136 304,200 252,264" fill="none" stroke="url(#g)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>',
	'</svg>',
].join('');

const LUCOS_FAVICON_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">',
	'<defs>',
	'<linearGradient id="g" x1="0" y1="0" x2="1" y2="0">',
	'<stop offset="0%" stop-color="#4EC3F8"/>',
	'<stop offset="50%" stop-color="#6B9EF0"/>',
	'<stop offset="100%" stop-color="#8B7DE8"/>',
	'</linearGradient>',
	'</defs>',
	'<rect width="100" height="100" rx="22" ry="22" fill="#0A0A0A"/>',
	'<polyline points="37,34 24,50 37,66" fill="none" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
	'<line x1="57" y1="31.5" x2="43" y2="68.5" stroke="url(#g)" stroke-width="6" stroke-linecap="round"/>',
	'<polyline points="63,34 76,50 63,66" fill="none" stroke="url(#g)" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>',
	'</svg>',
].join('');

async function generatePng(svgBuffer: Buffer, size: number): Promise<Buffer> {
	return sharp(svgBuffer)
		.resize(size, size)
		.png()
		.toBuffer();
}

async function generateIcns(svgBuf: Buffer): Promise<Buffer> {
	// ICNS binary format:
	// [magic: 4 bytes "icns"][file_length: 4 bytes big-endian]
	// For each icon: [type: 4 bytes][entry_size: 4 bytes][png_data: N bytes]
	const sizeToType: [number, string][] = [
		[16,   'icp4'],
		[32,   'icp5'],
		[64,   'icp6'],
		[128,  'ic07'],
		[256,  'ic08'],
		[512,  'ic09'],
		[1024, 'ic10'],
	];

	const entries: Buffer[] = [];
	for (const [sz, typeCode] of sizeToType) {
		const pngData = await generatePng(svgBuf, sz);
		const typeBuf = Buffer.from(typeCode, 'ascii');
		const sizeBuf = Buffer.alloc(4);
		sizeBuf.writeUInt32BE(pngData.length + 8, 0); // 8 = type(4) + size(4)
		entries.push(Buffer.concat([typeBuf, sizeBuf, pngData]));
	}

	const body = Buffer.concat(entries);
	const header = Buffer.alloc(8);
	header.write('icns', 0, 'ascii');
	header.writeUInt32BE(body.length + 8, 4);
	return Buffer.concat([header, body]);
}

async function main(): Promise<void> {
	const svgBuf = Buffer.from(LUCOS_ICON_SVG);

	console.log('Generating Lucos icon assets...\n');

	// Web/server icons
	const png192 = await generatePng(svgBuf, 192);
	writeFileSync(join(ROOT, 'resources/server/code-192.png'), png192);
	console.log('ok  resources/server/code-192.png');

	const png512 = await generatePng(svgBuf, 512);
	writeFileSync(join(ROOT, 'resources/server/code-512.png'), png512);
	console.log('ok  resources/server/code-512.png');

	// favicon.ico: 16, 32, 48, 64, 128, 256
	const icoSizes = [16, 32, 48, 64, 128, 256];
	const icoPngs = await Promise.all(icoSizes.map(sz => generatePng(svgBuf, sz)));
	const icoData = await pngToIco(icoPngs);
	writeFileSync(join(ROOT, 'resources/server/favicon.ico'), icoData);
	console.log('ok  resources/server/favicon.ico');

	// Win32 tile PNGs
	const png150 = await generatePng(svgBuf, 150);
	writeFileSync(join(ROOT, 'resources/win32/code_150x150.png'), png150);
	console.log('ok  resources/win32/code_150x150.png');

	const png70 = await generatePng(svgBuf, 70);
	writeFileSync(join(ROOT, 'resources/win32/code_70x70.png'), png70);
	console.log('ok  resources/win32/code_70x70.png');

	// macOS icon
	const icnsData = await generateIcns(svgBuf);
	writeFileSync(join(ROOT, 'resources/darwin/code.icns'), icnsData);
	console.log('ok  resources/darwin/code.icns');

	// favicon.svg
	writeFileSync(join(ROOT, 'resources/server/favicon.svg'), LUCOS_FAVICON_SVG);
	console.log('ok  resources/server/favicon.svg');

	console.log('\nAll Lucos icon assets generated successfully.');
}

main().catch(err => {
	console.error('Error:', err);
	process.exit(1);
});
