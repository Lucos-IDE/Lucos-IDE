/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ILucosAuthService = createDecorator<ILucosAuthService>('lucosAuthService');

export interface ILucosSignedInUser {
	readonly userId?: string;
	readonly email?: string;
}

export interface ILucosAuthService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the signed-in state changes (login, logout, restore). */
	readonly onDidChangeSignInState: Event<boolean>;

	/** True when a JWT is persisted in the OS keychain (no daemon required). */
	readonly isSignedIn: boolean;

	/** The signed-in user's id and email, if available from keychain (no daemon required). */
	readonly signedInUser: ILucosSignedInUser | undefined;

	/** Prompt for credentials, authenticate, persist the JWT, and hand it to the daemon. Returns true on success. */
	login(): Promise<boolean>;

	/** Open the system browser to Google OAuth. Resolves true once the deep-link callback delivers the JWT. */
	loginWithGoogle(): Promise<boolean>;

	/**
	 * Called by the deep-link handler on `lucos://auth/callback?success=true&token=...&refreshToken=...`.
	 * Stores both tokens and hands the access JWT (with userId) to the daemon.
	 */
	completeGoogleLogin(token: string, refreshToken: string, userId?: string, email?: string): Promise<void>;

	/**
	 * Called by the deep-link handler when Google or the gateway returns an error
	 * (`lucos://auth/callback?error=...`). Shows a notification and rejects the pending login.
	 */
	failGoogleLogin(errorDescription: string): void;

	/** Clear the stored JWT locally and in the daemon. */
	logout(): Promise<void>;

	/** On startup: if a JWT is in the keychain, hand it to the daemon so the session resumes. */
	restore(): Promise<void>;
}
