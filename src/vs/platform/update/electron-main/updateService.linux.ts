/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { memoize } from '../../../base/common/decorators.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import * as path from '../../../base/common/path.js';
import { IConfigurationService } from '../../configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { IFileService } from '../../files/common/files.js';
import { ILifecycleMainService, IRelaunchHandler, IRelaunchOptions } from '../../lifecycle/electron-main/lifecycleMainService.js';
import { ILogService } from '../../log/common/log.js';
import { IMeteredConnectionService } from '../../meteredConnection/common/meteredConnection.js';
import { INativeHostMainService } from '../../native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../product/common/productService.js';
import { asJson, IRequestService } from '../../request/common/request.js';
import { IApplicationStorageMainService } from '../../storage/electron-main/storageMainService.js';
import { ITelemetryService } from '../../telemetry/common/telemetry.js';
import { AvailableForDownload, IUpdate, State, StateType, UpdateType } from '../common/update.js';
import { AbstractUpdateService, createUpdateURL, IUpdateURLOptions } from './abstractUpdateService.js';
import { checkForUpdatesViaGitHub, downloadUpdateViaGitHub, getDefaultGitHubPackagePath, IGitHubUpdateContext, useGitHubReleases } from './gitHubUpdateHelper.js';

export class LinuxUpdateService extends AbstractUpdateService implements IRelaunchHandler {

	private gitHubPackagePath: string | undefined;

	@memoize
	get cachePath(): Promise<string> {
		const result = path.join(tmpdir(), `lucos-${this.productService.quality}-linux-${process.arch}`);
		return mkdir(result, { recursive: true }).then(() => result);
	}

	constructor(
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEnvironmentMainService environmentMainService: IEnvironmentMainService,
		@IRequestService requestService: IRequestService,
		@ILogService logService: ILogService,
		@INativeHostMainService private readonly nativeHostMainService: INativeHostMainService,
		@IProductService productService: IProductService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IApplicationStorageMainService applicationStorageMainService: IApplicationStorageMainService,
		@IMeteredConnectionService meteredConnectionService: IMeteredConnectionService,
		@IFileService private readonly fileService: IFileService,
	) {
		super(lifecycleMainService, configurationService, environmentMainService, requestService, logService, productService, telemetryService, applicationStorageMainService, meteredConnectionService, false);
		lifecycleMainService.setRelaunchHandler(this);
	}

	handleRelaunch(options?: IRelaunchOptions): boolean {
		if (options?.addArgs || options?.removeArgs) {
			return false;
		}

		if (this.state.type !== StateType.Ready) {
			return false;
		}

		this.doQuitAndInstall();
		return true;
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
				const extension = update.url?.includes('.AppImage') ? '.AppImage' : '.deb';
				return getDefaultGitHubPackagePath(cachePath, update, extension);
			},
			onDownloadReady: async (update, packagePath, explicit) => {
				this.gitHubPackagePath = packagePath;
				this.setState(State.Downloaded(update, explicit, this._overwrite));
				this.setState(State.Ready(update, explicit, this._overwrite));
			},
		};
	}

	protected buildUpdateFeedUrl(quality: string, commit: string, options?: IUpdateURLOptions): string | undefined {
		if (useGitHubReleases(this.productService)) {
			return `github://${this.productService.gitHubReleasesRepo}/${commit}`;
		}

		return createUpdateURL(this.productService.updateUrl!, `linux-${process.arch}`, quality, commit, options);
	}

	protected doCheckForUpdates(explicit: boolean, _pendingCommit?: string): void {
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
		const url = this.buildUpdateFeedUrl(this.quality, this.productService.commit!, { background, internalOrg });

		this.requestService.request({ url, callSite: 'updateService.linux.checkForUpdates' }, CancellationToken.None)
			.then<IUpdate | null>(asJson)
			.then(update => {
				if (!update || !update.url || !update.version || !update.productVersion) {
					this.setState(State.Idle(UpdateType.Archive, undefined, explicit || undefined));
				} else {
					this.setState(State.AvailableForDownload(update));
				}
			})
			.then(undefined, err => {
				this.logService.error(err);
				const message: string | undefined = explicit ? (err.message || err) : undefined;
				this.setState(State.Idle(UpdateType.Archive, message));
			});
	}

	protected override async doDownloadUpdate(state: AvailableForDownload): Promise<void> {
		if (useGitHubReleases(this.productService)) {
			await downloadUpdateViaGitHub(this.getGitHubContext(), state, true);
			return;
		}

		if (this.productService.downloadUrl && this.productService.downloadUrl.length > 0) {
			this.nativeHostMainService.openExternal(undefined, this.productService.downloadUrl);
		} else if (state.update.url) {
			this.nativeHostMainService.openExternal(undefined, state.update.url);
		}

		this.setState(State.Idle(UpdateType.Archive));
	}

	protected override doQuitAndInstall(): void {
		if (!this.gitHubPackagePath) {
			return;
		}

		const packagePath = this.gitHubPackagePath;
		if (packagePath.endsWith('.deb')) {
			spawn('xdg-open', [packagePath], { detached: true, stdio: 'ignore' });
		} else if (packagePath.endsWith('.AppImage')) {
			spawn('chmod', ['+x', packagePath], {
				detached: true,
				stdio: 'ignore',
			}).on('exit', () => {
				spawn(packagePath, [], { detached: true, stdio: 'ignore' });
			});
		}
	}
}
