/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { app } from 'electron';
import * as electron from 'electron';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { memoize } from '../../../base/common/decorators.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { hash } from '../../../base/common/hash.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import * as path from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { AbstractUpdateService, createUpdateURL, getUpdateRequestHeaders, IUpdateURLOptions, UpdateErrorClassification } from './abstractUpdateService.js';
import { checkForUpdatesViaGitHub, downloadUpdateViaGitHub, getDefaultGitHubPackagePath, IGitHubUpdateContext, useGitHubReleases } from './gitHubUpdateHelper.js';

export class DarwinUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private readonly disposables = new DisposableStore();
	private gitHubPackagePath: string | undefined;

	@memoize private get onRawError(): Event<string> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'error', (_, message) => message); }
	@memoize private get onRawCheckingForUpdate(): Event<void> { return Event.fromNodeEventEmitter<void>(electron.autoUpdater, 'checking-for-update'); }
	@memoize private get onRawUpdateNotAvailable(): Event<void> { return Event.fromNodeEventEmitter<void>(electron.autoUpdater, 'update-not-available'); }
	@memoize private get onRawUpdateAvailable(): Event<void> { return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-available'); }
	@memoize private get onRawUpdateDownloaded(): Event<IUpdate> {
		return Event.fromNodeEventEmitter(electron.autoUpdater, 'update-downloaded', (_, version: string, productVersion: string, releaseDate: Date | number) => ({
			version,
			productVersion,
			timestamp: releaseDate instanceof Date ? releaseDate.getTime() || undefined : releaseDate
		}));
	}

	@memoize
	get cachePath(): Promise<string> {
		const result = path.join(tmpdir(), `lucos-${this.productService.quality}-darwin-${process.arch}`);
		return mkdir(result, { recursive: true }).then(() => result);
	}

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@IProductService productService: IProductService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, true);

		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false;
		}

		if (this.state.type !== StateType.Ready) {
			return false;
		}

		this.logService.trace('update#handleRelaunch(): running raw#quitAndInstall()');
		this.doQuitAndInstall();

		return true;
	}

	protected override async initialize(): Promise<void> {
		await super.initialize();

		if (!useGitHubReleases(this.productService)) {
			this.onRawError(this.onError, this, this.disposables);
			this.onRawCheckingForUpdate(this.onCheckingForUpdate, this, this.disposables);
			this.onRawUpdateAvailable(this.onUpdateAvailable, this, this.disposables);
			this.onRawUpdateDownloaded(this.onUpdateDownloaded, this, this.disposables);
			this.onRawUpdateNotAvailable(this.onUpdateNotAvailable, this, this.disposables);
		}
	}

	private getGitHubContext(): IGitHubUpdateContext {
		return {
			productService: this.productService,
			requestService: this.requestService,
			fileService: this.fileService,
			logService: this.logService,
			telemetryService: this.telemetryService,
			getUpdateType: () => UpdateType.Archive,
			setState: state => this.setState(state),
			getState: () => this.state,
			getOverwrite: () => this._overwrite,
			getPackagePath: async update => {
				const cachePath = await this.cachePath;
				return getDefaultGitHubPackagePath(cachePath, update, '.dmg');
			},
			onDownloadReady: async (update, packagePath, explicit) => {
				this.gitHubPackagePath = packagePath;
				this.setState(State.Downloaded(update, explicit, this._overwrite));
				this.logService.info(`Update downloaded from GitHub: ${packagePath}`);
				this.setState(State.Ready(update, explicit, this._overwrite));
			},
		};
	}

	private onCheckingForUpdate(): void {
		this.logService.trace('update#onCheckingForUpdate - Electron autoUpdater is checking for updates');
	}

	private onError(err: string): void {
		this.telemetryService.publicLog2<{ messageHash: string }, UpdateErrorClassification>('update:error', { messageHash: String(hash(String(err))) });
		this.logService.error('UpdateService error:', err);

		const message = (this.state.type === StateType.CheckingForUpdates && this.state.explicit) ? err : undefined;
		this.setState(State.Idle(UpdateType.Archive, message));
	}

	protected buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string | undefined {
		if (useGitHubReleases(this.productService)) {
			return `github://${this.productService.gitHubReleasesRepo}/${commit}`;
		}

		const assetID = this.productService.darwinUniversalAssetId ?? (process.arch === 'x64' ? 'darwin' : 'darwin-arm64');
		const url = createUpdateURL(this.productService.updateUrl!, assetID, quality, commit, options);
		const headers = getUpdateRequestHeaders(this.productService.version);
		try {
			this.logService.trace('update#buildUpdateFeedUrl - setting feed URL for Electron autoUpdater', { url, assetID, quality, commit, headers });
			electron.autoUpdater.setFeedURL({ url, headers });
		} catch (e) {
			this.logService.error('Failed to set update feed URL', e);
			return undefined;
		}
		return url;
	}

	protected doCheckForUpdates(explicit: boolean, pendingCommit?: string): void {
		if (!this.quality) {
			return;
		}

		this.setState(State.CheckingForUpdates(explicit));

		if (useGitHubReleases(this.productService)) {
			void checkForUpdatesViaGitHub(this.getGitHubContext(), explicit);
			return;
		}

		const internalOrg = this.getInternalOrg();
		const background = !explicit && !internalOrg;
		const url = this.buildUpdateFeedUrl(this.quality, pendingCommit ?? this.productService.commit!, { background, internalOrg });

		if (!url) {
			this.setState(State.Idle(UpdateType.Archive));
			return;
		}

		if (!explicit && this.meteredConnectionService.isConnectionMetered) {
			this.logService.info('update#doCheckForUpdates - checking for update without auto-download because connection is metered');
			this.checkForUpdateNoDownload(url);
			return;
		}

		this.logService.trace('update#doCheckForUpdates - using Electron autoUpdater', { url, explicit, background });
		electron.autoUpdater.checkForUpdates();
	}

	private async checkForUpdateNoDownload(url: string, canInstall?: boolean): Promise<void> {
		const headers = getUpdateRequestHeaders(this.productService.version);
		this.logService.trace('update#checkForUpdateNoDownload - checking update server', { url, headers });

		try {
			const context = await this.requestService.request({ url, headers, callSite: 'updateService.darwin.checkForUpdates' }, CancellationToken.None);
			const statusCode = context.res.statusCode;
			this.logService.trace('update#checkForUpdateNoDownload - response', { statusCode });

			const update = await asJson<IUpdate>(context);
			if (!update || !update.url || !update.version || !update.productVersion) {
				this.logService.trace('update#checkForUpdateNoDownload - no update available');
				const notAvailable = this.state.type === StateType.CheckingForUpdates && this.state.explicit;
				this.setState(State.Idle(UpdateType.Archive, undefined, notAvailable || undefined));
			} else {
				this.logService.trace('update#checkForUpdateNoDownload - update available', { version: update.version, productVersion: update.productVersion });
				this.setState(State.AvailableForDownload(update, canInstall));
			}
		} catch (err) {
			this.logService.error('update#checkForUpdateNoDownload - failed to check for update', err);
			this.setState(State.Idle(UpdateType.Archive));
		}
	}

	private onUpdateAvailable(): void {
		this.logService.trace('update#onUpdateAvailable - Electron autoUpdater reported update available');

		if (this.state.type !== StateType.CheckingForUpdates && this.state.type !== StateType.Overwriting) {
			return;
		}

		this.setState(State.Downloading(this.state.type === StateType.Overwriting ? this.state.update : undefined, this.state.explicit, this._overwrite));
	}

	private onUpdateDownloaded(update: IUpdate): void {
		if (this.state.type !== StateType.Downloading) {
			return;
		}

		this.setState(State.Downloaded(update, this.state.explicit, this._overwrite));
		this.logService.info(`Update downloaded: ${JSON.stringify(update)}`);

		this.setState(State.Ready(update, this.state.explicit, this._overwrite));
	}

	private onUpdateNotAvailable(): void {
		this.logService.trace('update#onUpdateNotAvailable - Electron autoUpdater reported no update available');

		if (this.state.type !== StateType.CheckingForUpdates) {
			return;
		}

		const notAvailable = this.state.explicit;
		this.setState(State.Idle(UpdateType.Archive, undefined, notAvailable || undefined));
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		if (useGitHubReleases(this.productService)) {
			await downloadUpdateViaGitHub(this.getGitHubContext(), state, true);
			return;
		}

		this.buildUpdateFeedUrl(this.quality!, state.update.version, { internalOrg: this.getInternalOrg() });
		this.setState(State.CheckingForUpdates(true));
		electron.autoUpdater.checkForUpdates();
	}

	protected override doQuitAndInstall(): void {
		if (this.gitHubPackagePath) {
			const dmgPath = this.gitHubPackagePath;
			const targetAppPath = path.dirname(path.dirname(path.dirname(app.getPath('exe'))));
			const installScript = `set -e
MOUNT_POINT=$(hdiutil attach -nobrowse -readonly "${dmgPath}" | awk '/\\/Volumes\\// {print $3; exit}')
APP_PATH=$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" | head -1)
ditto "$APP_PATH" "${targetAppPath}"
hdiutil detach "$MOUNT_POINT" -quiet || true
open "${targetAppPath}"`;

			spawn('/bin/sh', ['-c', installScript], {
				detached: true,
				stdio: 'ignore',
			});

			app.quit();
			return;
		}

		this.logService.trace('update#quitAndInstall(): running raw#quitAndInstall()');
		electron.autoUpdater.quitAndInstall();
	}

	dispose(): void {
		this.disposables.dispose();
	}
}
