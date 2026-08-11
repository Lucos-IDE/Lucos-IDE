/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILucosConversationService, ILucosMessageEvent } from '../common/lucosConversationService.js';
import { ILucosMessage, ILucosSession, LucosMessageRole } from '../common/lucosConversation.js';

/** @deprecated Migrated into SESSIONS_STORAGE_KEY + ACTIVE_ID_STORAGE_KEY. */
const LEGACY_STORAGE_KEY = 'lucos.conversation.activeSession';
const SESSIONS_STORAGE_KEY = 'lucos.conversation.sessions';
const ACTIVE_ID_STORAGE_KEY = 'lucos.conversation.activeId';

/** Cap persisted history so storage stays bounded. */
const MAX_PERSISTED_MESSAGES = 200;
/** Cap open tabs / persisted sessions. */
const MAX_SESSIONS = 20;

export class LucosConversationService extends Disposable implements ILucosConversationService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveSession = this._register(new Emitter<ILucosSession>());
	readonly onDidChangeActiveSession: Event<ILucosSession> = this._onDidChangeActiveSession.event;

	private readonly _onDidChangeSessions = this._register(new Emitter<void>());
	readonly onDidChangeSessions: Event<void> = this._onDidChangeSessions.event;

	private readonly _onDidAddMessage = this._register(new Emitter<ILucosMessageEvent>());
	readonly onDidAddMessage: Event<ILucosMessageEvent> = this._onDidAddMessage.event;

	private readonly _onDidUpdateMessage = this._register(new Emitter<ILucosMessageEvent>());
	readonly onDidUpdateMessage: Event<ILucosMessageEvent> = this._onDidUpdateMessage.event;

	private readonly _sessions = new Map<string, ILucosSession>();
	private _activeSessionId: string;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		const restored = this._restore();
		if (restored.sessions.length === 0) {
			const fresh = this._createSession();
			this._sessions.set(fresh.id, fresh);
			this._activeSessionId = fresh.id;
		} else {
			for (const session of restored.sessions) {
				this._sessions.set(session.id, session);
			}
			this._activeSessionId = restored.activeId && this._sessions.has(restored.activeId)
				? restored.activeId
				: restored.sessions[0].id;
		}
	}

	get sessions(): readonly ILucosSession[] {
		return [...this._sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get activeSession(): ILucosSession {
		const session = this._sessions.get(this._activeSessionId);
		if (!session) {
			// Should be unreachable: constructor and closeSession always leave >= 1.
			const fresh = this._createSession();
			this._sessions.set(fresh.id, fresh);
			this._activeSessionId = fresh.id;
			return fresh;
		}
		return session;
	}

	newSession(): ILucosSession {
		this._evictOldestIfNeeded();
		const session = this._createSession();
		this._sessions.set(session.id, session);
		this._activeSessionId = session.id;
		this._persist();
		this._onDidChangeSessions.fire();
		this._onDidChangeActiveSession.fire(session);
		return session;
	}

	openSession(id: string): void {
		const session = this._sessions.get(id);
		if (!session || id === this._activeSessionId) {
			return;
		}
		this._activeSessionId = id;
		this._persist();
		this._onDidChangeActiveSession.fire(session);
	}

	closeSession(id: string): void {
		if (!this._sessions.has(id)) {
			return;
		}
		this._sessions.delete(id);

		if (this._sessions.size === 0) {
			const fresh = this._createSession();
			this._sessions.set(fresh.id, fresh);
			this._activeSessionId = fresh.id;
			this._persist();
			this._onDidChangeSessions.fire();
			this._onDidChangeActiveSession.fire(fresh);
			return;
		}

		const wasActive = id === this._activeSessionId;
		if (wasActive) {
			const next = this.sessions[0];
			this._activeSessionId = next.id;
		}
		this._persist();
		this._onDidChangeSessions.fire();
		if (wasActive) {
			this._onDidChangeActiveSession.fire(this.activeSession);
		}
	}

	renameSession(id: string, title: string): void {
		const session = this._sessions.get(id);
		if (!session) {
			return;
		}
		const trimmed = title.trim();
		if (!trimmed || trimmed === session.title) {
			return;
		}
		session.title = trimmed;
		session.updatedAt = Date.now();
		this._persist();
		this._onDidChangeSessions.fire();
	}

	addMessage(role: LucosMessageRole, content: string, streaming = false): ILucosMessage {
		const session = this.activeSession;
		const message: ILucosMessage = { id: generateUuid(), role, content, streaming, createdAt: Date.now() };
		session.messages.push(message);
		session.updatedAt = Date.now();
		if (role === LucosMessageRole.User && session.title === 'New chat' && content.trim()) {
			session.title = this._titleFromUserMessage(content);
			this._onDidChangeSessions.fire();
		}
		this._persist();
		this._onDidAddMessage.fire({ sessionId: session.id, message });
		return message;
	}

	appendToMessage(messageId: string, delta: string): void {
		const found = this._findAnywhere(messageId);
		if (!found) {
			return;
		}
		found.message.content += delta;
		found.session.updatedAt = Date.now();
		this._onDidUpdateMessage.fire({ sessionId: found.session.id, message: found.message });
	}

	replaceMessageContent(messageId: string, content: string): void {
		const found = this._findAnywhere(messageId);
		if (!found) {
			return;
		}
		found.message.content = content;
		found.session.updatedAt = Date.now();
		this._onDidUpdateMessage.fire({ sessionId: found.session.id, message: found.message });
	}

	completeMessage(messageId: string): void {
		const found = this._findAnywhere(messageId);
		if (!found || !found.message.streaming) {
			return;
		}
		found.message.streaming = false;
		this._persist();
		this._onDidUpdateMessage.fire({ sessionId: found.session.id, message: found.message });
	}

	private _findAnywhere(messageId: string): { session: ILucosSession; message: ILucosMessage } | undefined {
		for (const session of this._sessions.values()) {
			const message = session.messages.find(m => m.id === messageId);
			if (message) {
				return { session, message };
			}
		}
		return undefined;
	}

	private _createSession(): ILucosSession {
		return { id: generateUuid(), title: 'New chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
	}

	private _titleFromUserMessage(content: string): string {
		const singleLine = content.trim().replace(/\s+/g, ' ');
		return singleLine.length > 40 ? `${singleLine.slice(0, 40)}…` : singleLine;
	}

	private _evictOldestIfNeeded(): void {
		while (this._sessions.size >= MAX_SESSIONS) {
			const oldest = [...this._sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
			if (!oldest || oldest.id === this._activeSessionId) {
				// Prefer closing a non-active session; if somehow all are active-only, stop.
				const nonActive = [...this._sessions.values()]
					.filter(s => s.id !== this._activeSessionId)
					.sort((a, b) => a.updatedAt - b.updatedAt)[0];
				if (!nonActive) {
					break;
				}
				this._sessions.delete(nonActive.id);
				continue;
			}
			this._sessions.delete(oldest.id);
		}
	}

	private _persist(): void {
		const sessions = [...this._sessions.values()].map(session => ({
			...session,
			messages: session.messages.slice(-MAX_PERSISTED_MESSAGES).map(m => ({ ...m, streaming: false })),
		}));
		this.storageService.store(SESSIONS_STORAGE_KEY, JSON.stringify(sessions), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.storageService.store(ACTIVE_ID_STORAGE_KEY, this._activeSessionId, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private _restore(): { sessions: ILucosSession[]; activeId: string | undefined } {
		const multi = this._restoreMulti();
		if (multi) {
			return multi;
		}
		const legacy = this._restoreLegacy();
		if (legacy) {
			return { sessions: [legacy], activeId: legacy.id };
		}
		return { sessions: [], activeId: undefined };
	}

	private _restoreMulti(): { sessions: ILucosSession[]; activeId: string | undefined } | undefined {
		const raw = this.storageService.get(SESSIONS_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(raw) as ILucosSession[];
			if (!Array.isArray(parsed)) {
				return undefined;
			}
			const sessions = parsed.filter(s => s && typeof s.id === 'string' && Array.isArray(s.messages));
			if (sessions.length === 0) {
				return undefined;
			}
			const activeId = this.storageService.get(ACTIVE_ID_STORAGE_KEY, StorageScope.WORKSPACE);
			return { sessions, activeId };
		} catch {
			return undefined;
		}
	}

	private _restoreLegacy(): ILucosSession | undefined {
		const raw = this.storageService.get(LEGACY_STORAGE_KEY, StorageScope.WORKSPACE);
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
