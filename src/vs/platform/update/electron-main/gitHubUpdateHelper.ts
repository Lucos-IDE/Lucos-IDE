/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../base/common/cancellation.js';
import { hash } from '../../../base/common/hash.js';
import * as path from '../../../base/common/path.js';
import { IFileService } from '../../files/common/files.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IRequestService } from '../../request/common/request.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { UpdateErrorClassification } from './abstractUpdateService.js';
import {
	createUpdateFromRelease,
	downloadReleaseAsset,
	fetchLatestRelease,
	fetchReleaseManifest,
	GitHubReleasesError,
	isNewerVersion,
	resolveAssetForPlatform,
	toUserFacingError,
	verifyDownloadedAsset,
} from './gitHubReleasesClient.js';

export interface IGitHubUpdateContext {
	readonly productService: IProductService;
	readonly requestService: IRequestService;
	readonly fileService: IFileService;
	readonly logService: ILogService;
	readonly telemetryService: ITelemetryService;
	readonly getUpdateType: () => UpdateType;
	readonly setState: (state: import('../common/update.js').State) => void;
	readonly getState: () => import('../common/update.js').State;
	readonly getOverwrite: () => boolean;
	readonly getPackagePath: (update: IUpdate) => Promise<string>;
	readonly onDownloadReady: (update: IUpdate, packagePath: string, explicit: boolean) => Promise<void>;
}

export function useGitHubReleases(productService: IProductService): boolean {
	return Boolean(productService.gitHubReleasesRepo && productService.gitHubReleasesToken);
}

export async function checkForUpdatesViaGitHub(
	context: IGitHubUpdateContext,
	explicit: boolean,
): Promise<void> {
	const repo = context.productService.gitHubReleasesRepo!;
	const token = context.productService.gitHubReleasesToken!;

	try {
		const release = await fetchLatestRelease(context.requestService, repo, token, CancellationToken.None);
		const manifest = await fetchReleaseManifest(context.requestService, release, token, CancellationToken.None);
		const asset = resolveAssetForPlatform(release, process.platform, process.arch);

		const latestVersion = release.tag_name.replace(/^v/, '');
		const currentVersion = context.productService.version;

		if (!isNewerVersion(currentVersion, latestVersion)) {
			context.logService.trace('update#checkForUpdatesViaGitHub - already on latest version', { currentVersion, latestVersion });
			context.setState(State.Idle(context.getUpdateType(), undefined, explicit || undefined));
			return;
		}

		if (!asset) {
			throw new GitHubReleasesError(
				'No compatible GitHub release asset found',
				'Update available but no compatible download found for your platform.',
			);
		}

		const update = createUpdateFromRelease(release, asset, manifest, process.platform, process.arch);
		context.logService.info('update#checkForUpdatesViaGitHub - update available', { productVersion: update.productVersion, version: update.version });
		context.setState(State.AvailableForDownload(update));
	} catch (error) {
		context.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(error))) });
		context.logService.error('update#checkForUpdatesViaGitHub - failed', error);

		const message = explicit ? toUserFacingError(error) : undefined;
		context.setState(State.Idle(context.getUpdateType(), message));
	}
}

export async function downloadUpdateViaGitHub(
	context: IGitHubUpdateContext,
	state: AvailableForDownload,
	explicit: boolean,
): Promise<void> {
	const token = context.productService.gitHubReleasesToken!;
	const update = state.update;
	const startTime = Date.now();
	const cts = new CancellationTokenSource();

	context.setState(State.Downloading(update, explicit, context.getOverwrite(), 0, undefined, startTime));

	try {
		const packagePath = await context.getPackagePath(update);
		await downloadReleaseAsset(
			context.requestService,
			context.fileService,
			update.url!,
			token,
			packagePath,
			(downloadedBytes, totalBytes) => {
				if (context.getState().type === StateType.Downloading) {
					context.setState(State.Downloading(update, explicit, context.getOverwrite(), downloadedBytes, totalBytes, startTime));
				}
			},
			cts.token,
		);

		await verifyDownloadedAsset(packagePath, update.sha256hash);
		await context.onDownloadReady(update, packagePath, explicit);
	} catch (error) {
		cts.dispose();
		context.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(error))) });
		context.logService.error('update#downloadUpdateViaGitHub - failed', error);

		let message = toUserFacingError(error);
		if (/hash mismatch/i.test(message)) {
			message = 'Download verification failed. Please try again.';
		}

		if (explicit) {
			context.setState(State.Idle(context.getUpdateType(), message));
		} else {
			context.setState(State.AvailableForDownload(update));
		}
	}
}

export async function isLatestVersionViaGitHub(
	productService: IProductService,
	requestService: IRequestService,
	logService: ILogService,
	pendingCommit?: string,
	token: CancellationToken = CancellationToken.None,
): Promise<boolean | undefined> {
	if (!useGitHubReleases(productService)) {
		return undefined;
	}

	try {
		const release = await fetchLatestRelease(requestService, productService.gitHubReleasesRepo!, productService.gitHubReleasesToken!, token);
		if (pendingCommit && release.target_commitish.startsWith(pendingCommit)) {
			return true;
		}

		const latestVersion = release.tag_name.replace(/^v/, '');
		return !isNewerVersion(productService.version, latestVersion);
	} catch (error) {
		logService.error('update#isLatestVersionViaGitHub - failed', error);
		return undefined;
	}
}

export function getDefaultGitHubPackagePath(cacheRoot: string, update: IUpdate, extension: string): string {
	const version = update.productVersion ?? update.version;
	return path.join(cacheRoot, `lucos-${version}${extension}`);
}
