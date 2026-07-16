/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { dirname, join } from '../../../base/common/path.js';
import { LUCOS_IDE_EMBEDDED_PROTO } from './lucosEmbeddedProto.js';

type GrpcModule = typeof import('@grpc/grpc-js');
type ProtoLoaderModule = typeof import('@grpc/proto-loader');
type GrpcClient = import('@grpc/grpc-js').Client & Record<string, Function>;
type GrpcMetadata = import('@grpc/grpc-js').Metadata;
type GrpcServiceError = import('@grpc/grpc-js').ServiceError;
type GrpcReadableStream<T> = import('@grpc/grpc-js').ClientReadableStream<T>;

let grpcModulePromise: Promise<GrpcModule> | undefined;
let protoLoaderModulePromise: Promise<ProtoLoaderModule> | undefined;

function getGrpcModule(): Promise<GrpcModule> {
	grpcModulePromise ??= import('@grpc/grpc-js');
	return grpcModulePromise;
}

function getProtoLoaderModule(): Promise<ProtoLoaderModule> {
	protoLoaderModulePromise ??= import('@grpc/proto-loader');
	return protoLoaderModulePromise;
}

export interface ILucosDaemonEndpoint {
	/** `host:port`, e.g. `127.0.0.1:50051`. */
	readonly address: string;
	/** Local session token from `~/.lucos/daemon.json`. */
	readonly token: string;
}

/** Trimmed to the RPCs the IDE currently calls; the daemon service is a superset (that's fine for gRPC). */
const AGENT_PROTO = LUCOS_IDE_EMBEDDED_PROTO;

const TIMESTAMP_PROTO = `
syntax = "proto3";
package google.protobuf;
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
`;

let cachedProtoPath: string | undefined;

function ensureProtoOnDisk(): string {
	if (cachedProtoPath) {
		return cachedProtoPath;
	}
	const root = join(tmpdir(), 'lucos-ide-proto');
	const googleDir = join(root, 'google', 'protobuf');
	mkdirSync(googleDir, { recursive: true });
	const agentPath = join(root, 'agent.proto');
	writeFileSync(agentPath, AGENT_PROTO, 'utf8');
	writeFileSync(join(googleDir, 'timestamp.proto'), TIMESTAMP_PROTO, 'utf8');
	cachedProtoPath = agentPath;
	return agentPath;
}

/** Default deadline for unary RPCs. Missing deadlines hang forever on a dead port. */
const DEFAULT_UNARY_TIMEOUT_MS = 5_000;

export class LucosGrpcClient extends Disposable {

	private grpc: GrpcModule | undefined;
	private client: GrpcClient | undefined;
	private token = '';

	async connect(endpoint: ILucosDaemonEndpoint): Promise<void> {
		const [grpc, protoLoader] = await Promise.all([getGrpcModule(), getProtoLoaderModule()]);
		const protoPath = ensureProtoOnDisk();
		const definition = protoLoader.loadSync(protoPath, {
			keepCase: false,
			longs: String,
			enums: String,
			defaults: true,
			oneofs: true,
			includeDirs: [dirname(protoPath)],
		});
		const pkg = grpc.loadPackageDefinition(definition) as unknown as {
			lucos: { v1: { LucosDaemon: new (address: string, creds: import('@grpc/grpc-js').ChannelCredentials) => GrpcClient } };
		};
		this.close();
		this.grpc = grpc;
		this.client = new pkg.lucos.v1.LucosDaemon(endpoint.address, grpc.credentials.createInsecure());
		this.token = endpoint.token;
	}

	get isConnected(): boolean {
		return !!this.client;
	}

	health(): Promise<{ serving?: boolean; version?: string }> {
		return this.unary('health', {});
	}

	getAuthStatus(): Promise<Record<string, unknown>> {
		return this.unary('getAuthStatus', {});
	}

	setCloudCredentials(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.unary('setCloudCredentials', request);
	}

	clearCloudCredentials(): Promise<Record<string, unknown>> {
		return this.unary('clearCloudCredentials', {});
	}

	getPendingPatch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.unary('getPendingPatch', request);
	}

	applyPatch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.unary('applyPatch', request);
	}

	rejectPatch(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.unary('rejectPatch', request);
	}

	listCustomizations(request: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.unary('listCustomizations', request);
	}

	startAgentTask(request: Record<string, unknown>): GrpcReadableStream<Record<string, unknown>> {
		if (!this.client) {
			throw new Error('Lucos daemon not connected');
		}
		return this.client.startAgentTask(request, this.metadata());
	}

	indexWorkspace(request: Record<string, unknown>): GrpcReadableStream<Record<string, unknown>> {
		if (!this.client) {
			throw new Error('Lucos daemon not connected');
		}
		return this.client.indexWorkspace(request, this.metadata());
	}

	close(): void {
		try {
			this.client?.close();
		} catch {
			// ignore — best-effort teardown
		}
		this.client = undefined;
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}

	private metadata(): GrpcMetadata {
		if (!this.grpc) {
			throw new Error('Lucos daemon not connected');
		}
		const metadata = new this.grpc.Metadata();
		metadata.add('authorization', `Bearer ${this.token}`);
		return metadata;
	}

	private unary<T>(method: string, request: Record<string, unknown>, timeoutMs = DEFAULT_UNARY_TIMEOUT_MS): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (!this.client) {
				reject(new Error('Lucos daemon not connected'));
				return;
			}
			// Always set a deadline — without one, a dead/half-open localhost port
			// can leave Health / SetCloudCredentials pending forever and freeze startup.
			const options = { deadline: new Date(Date.now() + timeoutMs) };
			this.client[method](request, this.metadata(), options, (error: GrpcServiceError | null, response: T) => {
				if (error) {
					reject(error);
				} else {
					resolve(response);
				}
			});
		});
	}
}
