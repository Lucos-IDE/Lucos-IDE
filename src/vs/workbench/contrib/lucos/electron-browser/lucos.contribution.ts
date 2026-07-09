/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — desktop (electron) daemon wiring (TW-161).
 *  Registers the renderer-side proxy of the main-process daemon service, and binds the UI-facing
 *  ILucosDaemonService to the real gRPC-backed remote. Loaded from workbench.desktop.main.ts.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { registerMainProcessRemoteService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILucosDaemonNodeService, ipcLucosDaemonChannelName } from '../../../../platform/lucos/common/lucosDaemonNode.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { LucosDaemonServiceRemote } from './lucosDaemonServiceRemote.js';

// Renderer-side auto-proxy of the main-process daemon service (over IPC).
registerMainProcessRemoteService(ILucosDaemonNodeService, ipcLucosDaemonChannelName);

// UI-facing daemon service, backed by the real gRPC client via the proxy above.
registerSingleton(ILucosDaemonService, LucosDaemonServiceRemote, InstantiationType.Delayed);
