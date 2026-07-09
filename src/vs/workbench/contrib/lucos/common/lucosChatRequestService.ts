/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — chat request seam (TW-163 / TW-167).
 *  Lets editor commands (Cmd+K, Explain/Refactor/…) hand a goal + context to the chat view
 *  without the commands depending on the view. The view subscribes and runs the task through
 *  the existing streaming + patch-review machinery.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILucosWorkspaceContext } from '../../../../platform/lucos/common/lucosProtocol.js';

export const ILucosChatRequestService = createDecorator<ILucosChatRequestService>('lucosChatRequestService');

export interface ILucosChatRequest {
	readonly goal: string;
	readonly context?: ILucosWorkspaceContext;
	/** Optional skill/agent to run the task with (TW-184). */
	readonly selectedAgentPath?: string;
}

export interface ILucosChatRequestService {
	readonly _serviceBrand: undefined;
	readonly onDidRequest: Event<ILucosChatRequest>;
	/** Ask the chat view to run a task. Open/focus the view first so a listener exists. */
	submit(request: ILucosChatRequest): void;
}
