/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

	/** All open sessions, most-recently-updated first. Always at least one. */
	readonly sessions: readonly ILucosSession[];

	/** The currently active session. There is always exactly one. */
	readonly activeSession: ILucosSession;
	readonly onDidChangeActiveSession: Event<ILucosSession>;

	/** Fired when the session list changes (open/close/rename/new). */
	readonly onDidChangeSessions: Event<void>;

	/** Fired when a message is added to any session. */
	readonly onDidAddMessage: Event<ILucosMessageEvent>;
	/** Fired when a message's content or streaming flag changes. */
	readonly onDidUpdateMessage: Event<ILucosMessageEvent>;

	/** Start a fresh session and make it active. */
	newSession(): ILucosSession;

	/** Switch the active session. No-op if id is unknown. */
	openSession(id: string): void;

	/** Close a session. Always leaves at least one session (creates fresh if needed). */
	closeSession(id: string): void;

	/** Rename a session's title. */
	renameSession(id: string, title: string): void;

	/** Append a new message to the active session. */
	addMessage(role: LucosMessageRole, content: string, streaming?: boolean): ILucosMessage;

	/** Append a streamed delta to an existing message and fire an update. */
	appendToMessage(messageId: string, delta: string): void;

	/** Mark a message's streaming as finished. */
	completeMessage(messageId: string): void;
}
