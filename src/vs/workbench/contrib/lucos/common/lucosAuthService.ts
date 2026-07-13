/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
