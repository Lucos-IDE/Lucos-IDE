/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export const ILucosEntitlementsService = createDecorator<ILucosEntitlementsService>('lucosEntitlementsService');

/**
 * Seat entitlements from api.lucos.com (TW-249).
 * Shape is frozen in api.lucos.com/docs/SUBSCRIPTION-CONTRACTS.md section 3.
 */

/** How much of the plan's credit pool has been consumed this period. */
export const enum LucosDegradeMode {
	/** Under 80% spent — everything normal. */
	None = 'none',
	/** 80-99% spent — still fully working, but warn the user. */
	Warn = 'warn',
	/** 100% spent, or billing lapsed — Ask-only on the weak model. */
	Degraded = 'degraded',
}

export interface ILucosCredits {
	/** True when the plan has no token limit; includedUsd and remainingUsd are null. */
	readonly unlimited: boolean;
	readonly includedUsd: number | null;
	readonly bonusUsd: number;
	readonly spentUsd: number;
	readonly remainingUsd: number | null;
	readonly percentUsed: number;
}

export interface ILucosDegradeState {
	readonly mode: LucosDegradeMode;
	/** False once degraded: the tool loop is what makes agent turns expensive. */
	readonly agentToolsEnabled: boolean;
	/** Model to force while degraded, if the plan defines one. */
	readonly forcedModel: string | null;
}

export interface ILucosEntitlements {
	readonly seatId: string;
	readonly planCode: string;
	readonly planName: string;
	readonly subscriptionStatus: string;
	readonly credits: ILucosCredits;
	readonly period: { readonly start: string; readonly end: string };
	readonly degrade: ILucosDegradeState;
	readonly models: {
		readonly allowed: readonly string[];
		readonly default: string | null;
		readonly degrade: string | null;
	};
	readonly limits: {
		readonly maxIndexedRepos: number | null;
		readonly indexedRepoCount: number | null;
	};
	readonly links: { readonly upgrade: string; readonly billing: string };
}

export interface ILucosEntitlementsService {
	readonly _serviceBrand: undefined;

	/** Fires whenever entitlements are refreshed and something changed. */
	readonly onDidChangeEntitlements: Event<ILucosEntitlements | undefined>;

	/** Last known entitlements, or undefined before the first successful fetch. */
	readonly current: ILucosEntitlements | undefined;

	/** Cached read. Refetches only when the cache has expired. */
	get(): Promise<ILucosEntitlements | undefined>;

	/** Forces a refetch, ignoring the cache. Call after an upgrade or a 403. */
	refresh(): Promise<ILucosEntitlements | undefined>;

	/**
	 * True when the seat's plan permits this model.
	 * Unknown entitlements return true — never hide models because a request failed.
	 */
	isModelAllowed(modelId: string): boolean;
}
