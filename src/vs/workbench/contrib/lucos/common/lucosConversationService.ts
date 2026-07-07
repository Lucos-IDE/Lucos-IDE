/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — conversation store service (TW-160).
 *  Owns sessions, messages and streaming state. Pure client-side state; the chat view (TW-159)
 *  and timeline (TW-162) render from it. Kept separate from ILucosDaemonService so UI state and
 *  transport evolve independently.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILucosMessage, ILucosSession, LucosMessageRole } from './lucosConversation.js';

export const ILucosConversationService = createDecorator<ILucosConversationService>('lucosConversationService');

export interface ILucosMessageEvent {
	readonly sessionId: string;
	readonly message: ILucosMessage;
}

export interface ILucosConversationService {
	readonly _serviceBrand: undefined;

	/** The currently active session. There is always exactly one. */
	readonly activeSession: ILucosSession;
	readonly onDidChangeActiveSession: Event<ILucosSession>;

	/** Fired when a message is added to the active session. */
	readonly onDidAddMessage: Event<ILucosMessageEvent>;
	/** Fired when a message's content or streaming flag changes. */
	readonly onDidUpdateMessage: Event<ILucosMessageEvent>;

	/** Start a fresh session and make it active. */
	newSession(): ILucosSession;

	/** Append a new message to the active session. */
	addMessage(role: LucosMessageRole, content: string, streaming?: boolean): ILucosMessage;

	/** Append a streamed delta to an existing message and fire an update. */
	appendToMessage(messageId: string, delta: string): void;

	/** Mark a message's streaming as finished. */
	completeMessage(messageId: string): void;
}
