/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — auth orchestration service (TW-198).
 *  Owns the sign-in flow: prompt credentials → authenticate with the cloud gateway → store the
 *  JWT in the OS keychain → hand it to the daemon (SetCloudCredentials). Keeps all auth logic in
 *  one place; the daemon remains the source of truth for auth *state* (ILucosDaemonService).
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ILucosAuthService = createDecorator<ILucosAuthService>('lucosAuthService');

export interface ILucosAuthService {
	readonly _serviceBrand: undefined;

	/** Prompt for credentials, authenticate, persist the JWT, and hand it to the daemon. Returns true on success. */
	login(): Promise<boolean>;

	/** Clear the stored JWT locally and in the daemon. */
	logout(): Promise<void>;

	/** On startup: if a JWT is in the keychain, hand it to the daemon so the session resumes. */
	restore(): Promise<void>;
}
