/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — conversation store implementation (TW-160).
 *  In-memory sessions with lightweight workspace-scoped persistence of the active session so
 *  chat history survives IDE restarts.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILucosConversationService, ILucosMessageEvent } from '../common/lucosConversationService.js';
import { ILucosMessage, ILucosSession, LucosMessageRole } from '../common/lucosConversation.js';

const STORAGE_KEY = 'lucos.conversation.activeSession';
/** Cap persisted history so storage stays bounded. */
const MAX_PERSISTED_MESSAGES = 200;

export class LucosConversationService extends Disposable implements ILucosConversationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<ILucosSession>());
	readonly onDidChangeActiveSession: Event<ILucosSession> = this._onDidChangeActiveSession.event;

	private readonly _onDidAddMessage = this._register(new Emitter<ILucosMessageEvent>());
	readonly onDidAddMessage: Event<ILucosMessageEvent> = this._onDidAddMessage.event;

	private readonly _onDidUpdateMessage = this._register(new Emitter<ILucosMessageEvent>());
	readonly onDidUpdateMessage: Event<ILucosMessageEvent> = this._onDidUpdateMessage.event;

	private _activeSession: ILucosSession;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._activeSession = this._restore() ?? this._createSession();
	}

	get activeSession(): ILucosSession { return this._activeSession; }

	newSession(): ILucosSession {
		this._activeSession = this._createSession();
		this._persist();
		this._onDidChangeActiveSession.fire(this._activeSession);
		return this._activeSession;
	}

	addMessage(role: LucosMessageRole, content: string, streaming = false): ILucosMessage {
		const message: ILucosMessage = { id: generateUuid(), role, content, streaming, createdAt: Date.now() };
		this._activeSession.messages.push(message);
		this._activeSession.updatedAt = Date.now();
		this._persist();
		this._onDidAddMessage.fire({ sessionId: this._activeSession.id, message });
		return message;
	}

	appendToMessage(messageId: string, delta: string): void {
		const message = this._find(messageId);
		if (!message) {
			return;
		}
		message.content += delta;
		this._activeSession.updatedAt = Date.now();
		this._onDidUpdateMessage.fire({ sessionId: this._activeSession.id, message });
	}

	completeMessage(messageId: string): void {
		const message = this._find(messageId);
		if (!message || !message.streaming) {
			return;
		}
		message.streaming = false;
		this._persist();
		this._onDidUpdateMessage.fire({ sessionId: this._activeSession.id, message });
	}

	private _find(messageId: string): ILucosMessage | undefined {
		return this._activeSession.messages.find(m => m.id === messageId);
	}

	private _createSession(): ILucosSession {
		return { id: generateUuid(), title: 'New chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
	}

	private _persist(): void {
		const toStore: ILucosSession = {
			...this._activeSession,
			messages: this._activeSession.messages.slice(-MAX_PERSISTED_MESSAGES).map(m => ({ ...m, streaming: false })),
		};
		this.storageService.store(STORAGE_KEY, JSON.stringify(toStore), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _restore(): ILucosSession | undefined {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as ILucosSession;
			if (!parsed || !Array.isArray(parsed.messages)) {
				return undefined;
			}
			return parsed;
		} catch {
			return undefined;
		}
	}
}
