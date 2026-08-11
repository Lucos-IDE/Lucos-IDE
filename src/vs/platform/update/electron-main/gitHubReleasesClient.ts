/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { unlink } from 'fs/promises';
import { Delayer } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { transform } from '../../../base/common/stream.js';
import { URI } from '../../../base/common/uri.js';
import { checksum } from '../../../base/node/crypto.js';
import * as pfs from '../../../base/node/pfs.js';
import { IFileService } from '../../files/common/files.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IUpdate } from '../common/update.js';

export interface IGitHubReleaseAsset {
	readonly id: number;
	readonly name: string;
	readonly url: string;
	readonly browser_download_url: string;
	readonly size: number;
}

export interface IGitHubRelease {
	readonly tag_name: string;
	readonly name: string;
	readonly body: string;
	readonly published_at: string;
	readonly html_url: string;
	readonly assets: IGitHubReleaseAsset[];
	readonly target_commitish: string;
}

export interface IGitHubReleaseManifest {
	readonly version: string;
	readonly commit: string;
	readonly timestamp: string;
	readonly assets: Record<string, { readonly name: string; readonly sha256: string }>;
}

export type GitHubUpdateProgress = (downloadedBytes: number, totalBytes: number | undefined) => void;

export class GitHubReleasesError extends Error {
	constructor(
		message: string,
		readonly userMessage: string,
		readonly statusCode?: number,
	) {
		super(message);
		this.name = 'GitHubReleasesError';
	}
}

export function getPlatformAssetKey(platform: NodeJS.Platform, arch: string): string {
	if (platform === 'darwin') {
		return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
	}
	if (platform === 'win32') {
		return 'win32-x64';
	}
	return 'linux-x64';
}

export function getExpectedAssetName(version: string, platform: NodeJS.Platform, arch: string): string {
	const productVersion = version.replace(/^v/, '');
	const key = getPlatformAssetKey(platform, arch);
	switch (key) {
		case 'darwin-arm64':
			return `lucos-${productVersion}-darwin-arm64.dmg`;
		case 'darwin-x64':
			return `lucos-${productVersion}-darwin-x64.dmg`;
		case 'win32-x64':
			return `lucos-${productVersion}-win32-x64.exe`;
		case 'linux-x64':
			return `lucos-${productVersion}-linux-x64.deb`;
		default:
			return `lucos-${productVersion}-linux-x64.AppImage`;
	}
}

export function compareVersions(currentVersion: string, latestVersion: string): number {
	const current = parseVersion(currentVersion.replace(/^v/, ''));
	const latest = parseVersion(latestVersion.replace(/^v/, ''));
	if (!current || !latest) {
		return 0;
	}

	if (latest.major !== current.major) {
		return latest.major - current.major;
	}
	if (latest.minor !== current.minor) {
		return latest.minor - current.minor;
	}
	return latest.patch - current.patch;
}

function parseVersion(version: string): { major: number; minor: number; patch: number } | undefined {
	const match = /^(\d{1,10})\.(\d{1,10})\.(\d{1,10})/.exec(version);
	if (!match) {
		return undefined;
	}

	return {
		major: parseInt(match[1], 10),
		minor: parseInt(match[2], 10),
		patch: parseInt(match[3], 10),
	};
}

export function isNewerVersion(currentVersion: string, latestVersion: string): boolean {
	return compareVersions(currentVersion, latestVersion) > 0;
}

export function resolveAssetForPlatform(release: IGitHubRelease, platform: NodeJS.Platform, arch: string): IGitHubReleaseAsset | undefined {
	const expectedName = getExpectedAssetName(release.tag_name, platform, arch);
	const exact = release.assets.find(asset => asset.name === expectedName);
	if (exact) {
		return exact;
	}

	const key = getPlatformAssetKey(platform, arch);
	const suffix = key === 'darwin-arm64' ? 'darwin-arm64.dmg'
		: key === 'darwin-x64' ? 'darwin-x64.dmg'
			: key === 'win32-x64' ? 'win32-x64.exe'
				: key === 'linux-x64' ? 'linux-x64.deb'
					: 'linux-x64.AppImage';

	return release.assets.find(asset => asset.name.endsWith(suffix));
}

export function toUserFacingError(error: unknown): string {
	if (error instanceof GitHubReleasesError) {
		return error.userMessage;
	}

	const message = error instanceof Error ? error.message : String(error);
	if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|timed out|connection was lost/i.test(message)) {
		return 'Could not check for updates. Please check your internet connection.';
	}

	return message;
}

function getGitHubHeaders(token: string, accept: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: accept,
		'X-GitHub-Api-Version': '2022-11-28',
	};
}

export async function fetchLatestRelease(
	requestService: IRequestService,
	repo: string,
	token: string,
	tokenCancellation: CancellationToken,
): Promise<IGitHubRelease> {
	const url = `https://api.github.com/repos/${repo}/releases/latest`;
	try {
		const context = await requestService.request({
			url,
			headers: getGitHubHeaders(token, 'application/vnd.github+json'),
			callSite: 'gitHubReleasesClient.fetchLatestRelease',
		}, tokenCancellation);

		if (context.res.statusCode === 401 || context.res.statusCode === 403) {
			throw new GitHubReleasesError(
				`GitHub Releases auth failed with status ${context.res.statusCode}`,
				'Update check failed: authentication error. Please contact support.',
				context.res.statusCode,
			);
		}

		if (context.res.statusCode && context.res.statusCode >= 400) {
			throw new GitHubReleasesError(
				`GitHub Releases request failed with status ${context.res.statusCode}`,
				'Could not check for updates. Please try again later.',
				context.res.statusCode,
			);
		}

		const release = await asJson<IGitHubRelease>(context);
		if (!release?.tag_name || !Array.isArray(release.assets)) {
			throw new GitHubReleasesError('Invalid GitHub release response', 'Could not check for updates. Please try again later.');
		}

		return release;
	} catch (error) {
		if (error instanceof GitHubReleasesError) {
			throw error;
		}
		throw new GitHubReleasesError(String(error), toUserFacingError(error));
	}
}

export async function fetchReleaseManifest(
	requestService: IRequestService,
	release: IGitHubRelease,
	token: string,
	tokenCancellation: CancellationToken,
): Promise<IGitHubReleaseManifest | undefined> {
	const manifestAsset = release.assets.find(asset => asset.name === 'latest.json');
	if (!manifestAsset) {
		return undefined;
	}

	const context = await requestService.request({
		url: manifestAsset.url,
		headers: getGitHubHeaders(token, 'application/octet-stream'),
		callSite: 'gitHubReleasesClient.fetchReleaseManifest',
	}, tokenCancellation);

	if (context.res.statusCode && context.res.statusCode >= 400) {
		return undefined;
	}

	return (await asJson<IGitHubReleaseManifest>(context)) ?? undefined;
}

export function createUpdateFromRelease(
	release: IGitHubRelease,
	asset: IGitHubReleaseAsset,
	manifest: IGitHubReleaseManifest | undefined,
	platform: NodeJS.Platform,
	arch: string,
): IUpdate {
	const productVersion = release.tag_name.replace(/^v/, '');
	const key = getPlatformAssetKey(platform, arch);
	const sha256hash = manifest?.assets[key]?.sha256;

	return {
		version: manifest?.commit || release.target_commitish,
		productVersion,
		timestamp: Date.parse(release.published_at) || undefined,
		url: asset.url,
		sha256hash,
	};
}

export async function downloadReleaseAsset(
	requestService: IRequestService,
	fileService: IFileService,
	assetUrl: string,
	token: string,
	destinationPath: string,
	onProgress: GitHubUpdateProgress,
	tokenCancellation: CancellationToken,
): Promise<void> {
	const downloadPath = `${destinationPath}.tmp`;
	try {
		await unlink(downloadPath);
	} catch {
		// ignore missing temp file
	}

	const context = await requestService.request({
		url: assetUrl,
		headers: getGitHubHeaders(token, 'application/octet-stream'),
		callSite: 'gitHubReleasesClient.downloadReleaseAsset',
	}, tokenCancellation);

	if (context.res.statusCode === 401 || context.res.statusCode === 403) {
		throw new GitHubReleasesError(
			`GitHub asset download auth failed with status ${context.res.statusCode}`,
			'Update check failed: authentication error. Please contact support.',
			context.res.statusCode,
		);
	}

	if (context.res.statusCode && context.res.statusCode >= 400) {
		throw new GitHubReleasesError(
			`GitHub asset download failed with status ${context.res.statusCode}`,
			'Could not download the update. Please try again.',
			context.res.statusCode,
		);
	}

	const contentLengthHeader = context.res.headers['content-length'];
	const contentLength = typeof contentLengthHeader === 'string' ? contentLengthHeader : undefined;
	const totalBytes = contentLength ? parseInt(contentLength, 10) : undefined;

	let downloadedBytes = 0;
	const progressDelayer = new Delayer<void>(500);
	const progressStream = transform<VSBuffer, VSBuffer>(
		context.stream,
		{
			data: data => {
				downloadedBytes += data.byteLength;
				progressDelayer.trigger(() => onProgress(downloadedBytes, totalBytes));
				return data;
			}
		},
		chunks => VSBuffer.concat(chunks),
	);

	try {
		await fileService.writeFile(URI.file(downloadPath), progressStream);
	} finally {
		progressDelayer.dispose();
	}

	onProgress(downloadedBytes, totalBytes);
	await pfs.Promises.rename(downloadPath, destinationPath, false);
}

export async function verifyDownloadedAsset(path: string, expectedSha256?: string): Promise<void> {
	if (!expectedSha256) {
		return;
	}

	await checksum(path, expectedSha256);
}
