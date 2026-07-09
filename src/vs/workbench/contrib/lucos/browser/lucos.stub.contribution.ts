/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — daemon stub binding for non-desktop (web) contexts (TW-161).
 *  Desktop uses the real gRPC-backed service (electron-browser/lucos.contribution.ts); web has no
 *  local daemon, so it falls back to the stub. Loaded from workbench.web.main.ts.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILucosDaemonService } from '../common/lucosDaemonService.js';
import { LucosDaemonServiceStub } from './lucosDaemonServiceStub.js';

registerSingleton(ILucosDaemonService, LucosDaemonServiceStub, InstantiationType.Delayed);
