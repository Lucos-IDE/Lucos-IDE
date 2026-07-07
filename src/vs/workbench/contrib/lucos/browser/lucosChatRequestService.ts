/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — chat request seam implementation (TW-163 / TW-167).
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILucosChatRequest, ILucosChatRequestService } from '../common/lucosChatRequestService.js';

export class LucosChatRequestService extends Disposable implements ILucosChatRequestService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRequest = this._register(new Emitter<ILucosChatRequest>());
	readonly onDidRequest: Event<ILucosChatRequest> = this._onDidRequest.event;

	submit(request: ILucosChatRequest): void {
		this._onDidRequest.fire(request);
	}
}
