/*---------------------------------------------------------------------------------------------
 *  Lucos IDE — raw gRPC client to the local daemon (TW-161). NODE layer only.
 *
 *  The daemon writes its address + rotating session token to `~/.lucos/daemon.json`; every call
 *  carries `authorization: Bearer <token>` metadata. The proto is embedded and materialised to a
 *  temp dir so no build-time asset copying is required (switch to codegen later if preferred).
 *
 *  NOTE: runtime behaviour needs validation with a live daemon + a working native build — this
 *  file typechecks but has not been exercised end-to-end.
 *--------------------------------------------------------------------------------------------*/

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { Disposable } from '../../../base/common/lifecycle.js';
import { dirname, join } from '../../../base/common/path.js';

export interface ILucosDaemonEndpoint {
	/** `host:port`, e.g. `127.0.0.1:50051`. */
	readonly address: string;
	/** Local session token from `~/.lucos/daemon.json`. */
	readonly token: string;
}

/** Trimmed to the RPCs the IDE currently calls; the daemon service is a superset (that's fine for gRPC). */
const AGENT_PROTO = `
syntax = "proto3";
package lucos.v1;
import "google/protobuf/timestamp.proto";

service LucosDaemon {
  rpc Health(HealthRequest) returns (HealthResponse);
  rpc GetAuthStatus(AuthStatusRequest) returns (AuthStatusResponse);
  rpc SetCloudCredentials(SetCloudCredentialsRequest) returns (SetCloudCredentialsResponse);
  rpc ClearCloudCredentials(ClearCloudCredentialsRequest) returns (ClearCloudCredentialsResponse);
  rpc StartAgentTask(StartAgentTaskRequest) returns (stream TaskEvent);
  rpc GetPendingPatch(GetPendingPatchRequest) returns (PatchProposal);
  rpc ApplyPatch(ApplyPatchRequest) returns (ApplyPatchResponse);
  rpc RejectPatch(RejectPatchRequest) returns (RejectPatchResponse);
  rpc ListCustomizations(ListCustomizationsRequest) returns (CustomizationsSnapshot);
  rpc IndexWorkspace(IndexWorkspaceRequest) returns (stream TaskEvent);
}

message HealthRequest {}
message HealthResponse { bool serving = 1; string version = 2; }

enum AuthState {
  AUTH_STATE_UNSPECIFIED = 0;
  AUTH_STATE_UNAUTHENTICATED = 1;
  AUTH_STATE_AUTHENTICATING = 2;
  AUTH_STATE_AUTHENTICATED = 3;
  AUTH_STATE_TOKEN_EXPIRED = 4;
  AUTH_STATE_CLOUD_UNREACHABLE = 5;
  AUTH_STATE_OFFLINE_MODE = 6;
}

message AuthStatusRequest {}
message AuthStatusResponse {
  AuthState state = 1;
  string user_id = 2;
  string org_id = 3;
  string plan_code = 4;
  repeated string roles = 5;
  bool cloud_reachable = 6;
  google.protobuf.Timestamp token_expires_at = 7;
}

message SetCloudCredentialsRequest {
  string access_token = 1;
  google.protobuf.Timestamp expires_at = 2;
  string user_id = 3;
  string org_id = 4;
}
message SetCloudCredentialsResponse { AuthStatusResponse status = 1; }

message ClearCloudCredentialsRequest {}
message ClearCloudCredentialsResponse { AuthStatusResponse status = 1; }

message StartAgentTaskRequest {
  string goal = 1;
  string workspace_id = 2;
  string active_file = 3;
  string selection = 4;
  repeated string open_buffers = 5;
  string permission_mode = 6;
  string model = 7;
  string session_id = 8;
  string selected_agent_path = 9;
  string workspace_root = 10;
}

message TaskEvent {
  string task_id = 1;
  string event_type = 2;
  int64 sequence = 3;
  google.protobuf.Timestamp timestamp = 4;
  string payload_json = 5;
  string severity = 6;
}

message FileChange {
  string path = 1;
  string old_text = 2;
  string new_text = 3;
  string base_hash = 4;
}

message PatchProposal {
  string patch_id = 1;
  string task_id = 2;
  string summary = 3;
  repeated FileChange file_changes = 4;
  string status = 5;
}

message GetPendingPatchRequest { string patch_id = 1; }

message ApplyPatchRequest {
  string patch_id = 1;
  string workspace_root = 2;
}

message ApplyPatchResponse {
  string patch_id = 1;
  repeated string files_changed = 2;
  repeated string created = 3;
  repeated string modified = 4;
  repeated string deleted = 5;
}

message RejectPatchRequest { string patch_id = 1; }
message RejectPatchResponse { string patch_id = 1; }

message ListCustomizationsRequest { string workspace_root = 1; }

message SkillEntry {
  string name = 1;
  string description = 2;
  string path = 3;
  string scope = 4;
  repeated string allowed_tools = 5;
  bool user_invocable = 6;
  bool disable_model_invocation = 7;
  string content_hash = 8;
}

message AgentEntry {
  string name = 1;
  string display_name = 2;
  string description = 3;
  string path = 4;
  string scope = 5;
  repeated string tools = 6;
  string model = 7;
  bool user_invocable = 8;
  bool disable_model_invocation = 9;
  string content_hash = 10;
}

message InstructionEntry {
  string path = 1;
  string scope = 2;
  string content_hash = 3;
  string name = 4;
  string description = 5;
  repeated string apply_to = 6;
}

message RepoRuleEntry {
  string path = 1;
  string kind = 2;
  string content_hash = 3;
}

message CustomizationsSnapshot {
  repeated SkillEntry skills = 1;
  repeated AgentEntry agents = 2;
  repeated InstructionEntry instructions = 3;
  repeated RepoRuleEntry repo_rules = 4;
  google.protobuf.Timestamp scanned_at = 5;
}

message IndexWorkspaceRequest {
  string workspace_root = 1;
  string workspace_id = 2;
  bool force_rescan = 3;
  repeated string ignore_patterns = 4;
}
`;

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

export class LucosGrpcClient extends Disposable {

	private client: grpc.Client & Record<string, Function> | undefined;
	private token = '';

	connect(endpoint: ILucosDaemonEndpoint): void {
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
			lucos: { v1: { LucosDaemon: new (address: string, creds: grpc.ChannelCredentials) => grpc.Client & Record<string, Function> } };
		};
		this.close();
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

	startAgentTask(request: Record<string, unknown>): grpc.ClientReadableStream<Record<string, unknown>> {
		if (!this.client) {
			throw new Error('Lucos daemon not connected');
		}
		return this.client.startAgentTask(request, this.metadata());
	}

	indexWorkspace(request: Record<string, unknown>): grpc.ClientReadableStream<Record<string, unknown>> {
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

	private metadata(): grpc.Metadata {
		const metadata = new grpc.Metadata();
		metadata.add('authorization', `Bearer ${this.token}`);
		return metadata;
	}

	private unary<T>(method: string, request: Record<string, unknown>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (!this.client) {
				reject(new Error('Lucos daemon not connected'));
				return;
			}
			this.client[method](request, this.metadata(), (error: grpc.ServiceError | null, response: T) => {
				if (error) {
					reject(error);
				} else {
					resolve(response);
				}
			});
		});
	}
}
