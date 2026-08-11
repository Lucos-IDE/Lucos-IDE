/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum LucosMessageRole {
	User = 'user',
	Assistant = 'assistant',
	System = 'system',
}

export interface ILucosMessage {
	readonly id: string;
	readonly role: LucosMessageRole;
	/** Mutable while streaming; appended to as `model.delta` events arrive. */
	content: string;
	/** True while the assistant response is still streaming. */
	streaming: boolean;
	/** Epoch milliseconds. */
	readonly createdAt: number;
}

export interface ILucosSession {
	readonly id: string;
	title: string;
	readonly messages: ILucosMessage[];
	/** Epoch milliseconds. */
	readonly createdAt: number;
	/** Epoch milliseconds. */
	updatedAt: number;
}
