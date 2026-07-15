# Lucos AI — VS Code UI & Workbench

This document maps the Lucos AI feature set (the "VS Code UI & Workbench" workstream) to its
source files, explains the architecture, and gives a runtime-validation checklist. All code
typechecks against VS Code 1.128 (`npm run typecheck-client`), but the daemon-dependent paths
have **not** yet been exercised at runtime (they need a live daemon + a working native build).

---

## Architecture

```
Renderer (sandboxed)                         Main process (node)              Local machine
┌──────────────────────────┐                ┌────────────────────────┐
│ UI (chat, Cmd+K, diff,   │  ILucosDaemon  │ LucosDaemonNodeService │  gRPC   ┌──────────┐
│ status bar, login, …)    │───Service──────│  (@grpc/grpc-js)       │────────▶│  daemon  │
│                          │      │         └────────────────────────┘ 127.0.0.1└──────────┘
│ LucosDaemonServiceRemote │──ProxyChannel(IPC)──▲                              ~/.lucos/daemon.json
└──────────────────────────┘   ILucosDaemonNodeService
        │ (web build)
        └── LucosDaemonServiceStub   ← no daemon; lets the whole UI run standalone
```

**Golden rule:** every UI component depends only on `ILucosDaemonService`. It is bound
per-platform — desktop → the real gRPC-backed remote, web → the stub — so nothing in the UI
changes between them. gRPC never runs in the sandboxed renderer; it runs in the main process and
is reached over a VS Code `ProxyChannel`.

Contribution-only: **no VS Code core logic is modified** (only import lines added to the
workbench/main entrypoints), keeping upstream merges clean per the fork-governance policy.

---

## Module layout

```
src/vs/platform/lucos/                         ← shared across the IPC boundary
├── common/
│   ├── lucosProtocol.ts                       domain types (health, auth, task events, patches, customizations)
│   └── lucosDaemonNode.ts                     ILucosDaemonNodeService (channel-facing) + channel name
└── node/
    ├── lucosGrpcClient.ts                     raw @grpc/grpc-js client (embedded proto, daemon.json, Bearer)
    └── lucosDaemonNodeService.ts              main-process service; wire↔domain mapping, per-task streaming

src/vs/workbench/contrib/lucos/                ← the UI
├── common/
│   ├── lucosDaemonService.ts                  ILucosDaemonService (UI-facing seam)
│   ├── lucosConfiguration.ts                  setting ids
│   ├── lucosConversation.ts                   message/session model
│   ├── lucosConversationService.ts            conversation store interface
│   ├── lucosAuthService.ts                    auth service interface
│   ├── lucosChatRequestService.ts             "submit to chat" seam (Cmd+K / palette → view)
│   └── lucosIndexService.ts                   ILucosIndexService (workspace index state seam)
├── browser/
│   ├── lucos.contribution.ts                  main registration hub (services, settings, view, actions)
│   ├── lucos.stub.contribution.ts             web: bind stub daemon
│   ├── lucosCommands.ts                        shared command/container ids
│   ├── lucosDaemonServiceStub.ts              stub daemon (runs the UI without a daemon)
│   ├── lucosConversationService.ts            conversation store impl (persisted)
│   ├── lucosViewPane.ts                       the chat view (streaming, banner, timeline, @mentions, patch)
│   ├── lucosStatusBar.ts                      status bar entry
│   ├── lucosAuthService.ts                    auth impl (gateway → keychain → daemon)
│   ├── lucosLoginActions.ts                   sign-in/out commands + startup restore
│   ├── lucosActivityTimeline.ts               agent activity widget
│   ├── lucosContextPicker.ts                  @selection / @file / @workspace capture
│   ├── lucosPatchReview.ts                    patch review card + native diff + accept/reject
│   ├── lucosChatRequestService.ts             submit-to-chat impl
│   ├── lucosIndexService.ts                   folds daemon index.* events → status + completion/failure notifications
│   ├── lucosEditorActions.ts                  Cmd+K + palette (Explain/Refactor/Tests/Review) + skill/agent + Index Workspace
│   └── lucosNotifications.ts                  global offline notification (debounced)
├── electron-browser/
│   ├── lucos.contribution.ts                  desktop: bind real gRPC-backed daemon service
│   └── lucosDaemonServiceRemote.ts            renderer proxy → node service (AsyncIterable re-assembly)
└── test/browser/
    └── lucosDaemonServiceStub.test.ts         unit tests
```

**Wiring touch-points (import lines only):**
`workbench.common.main.ts`, `workbench.desktop.main.ts`, `workbench.web.main.ts`,
`src/vs/code/electron-main/app.ts` (registers the node service + channel), and `package.json`
(`@grpc/grpc-js`, `@grpc/proto-loader`).

---

## Ticket → files

| Ticket | Files |
|--------|-------|
| **TW-158** Activity Bar | `lucos.contribution.ts` (view container + focus command), `lucosViewPane.ts`, `lucosCommands.ts` |
| **TW-159** AI Chat | `lucosViewPane.ts` (streaming, composer, cancel) |
| **TW-160** Conversation Store | `common/lucosConversation.ts`, `common/lucosConversationService.ts`, `browser/lucosConversationService.ts` |
| **TW-161** gRPC Client | `platform/lucos/**`, `electron-browser/lucosDaemonServiceRemote.ts`, `electron-browser/lucos.contribution.ts`, `browser/lucos.stub.contribution.ts`, `app.ts`, mains, `package.json`. **`StartAgentTask` now sends `workspace_root`** (from `IWorkspaceContextService`, via `ILucosWorkspaceContext.workspaceRoot`) — required by daemon file tools |
| **TW-162** Activity Timeline | `lucosActivityTimeline.ts` |
| **TW-163** Cmd+K | `lucosEditorActions.ts` (`LucosCmdKAction`), `lucosChatRequestService.ts` |
| **TW-164** @mentions | `lucosContextPicker.ts`, `lucosViewPane.ts` (chips + threading) |
| **TW-165** Diff Viewer | `lucosPatchReview.ts` + patch RPCs across the daemon layers |
| **TW-166** Apply/Reject | `lucosPatchReview.ts` (accept→`applyPatch`, reject→`rejectPatch`) |
| **TW-167** Command Palette | `lucosEditorActions.ts` (Explain / Refactor / Generate Tests / Review Changes) |
| **TW-168** Settings | `lucos.contribution.ts` (`registerConfiguration`), `common/lucosConfiguration.ts` |
| **TW-169** Status Bar | `lucosStatusBar.ts` (connection + model + index state) |
| **TW-170** Notifications | `lucosNotifications.ts` (offline) + `lucosIndexService.ts` (index complete/failure) |
| **TW-172** Error Handling | `lucosViewPane.ts` (offline banner + auth/quota events), `lucosIndexService.ts` (`index.failed`) |
| **TW-220** Index Workspace | `common/lucosIndexService.ts`, `browser/lucosIndexService.ts`, `lucosEditorActions.ts` (`LucosIndexWorkspaceAction`), `indexWorkspace` across all daemon layers (`lucosProtocol.ts`, `lucosGrpcClient.ts`, `lucosDaemonNode.ts`, `lucosDaemonNodeService.ts`, `lucosDaemonServiceRemote.ts`, `lucosDaemonServiceStub.ts`, `lucosDaemonService.ts`) |
| **TW-173** UI Performance | `lucosViewPane.ts` (rAF-batched streaming updates) |
| **TW-174** Testing | `test/browser/lucosDaemonServiceStub.test.ts`, `platform/lucos/test/node/lucosProtoDrift.test.ts` |
| **TW-184** Customizations | `lucosEditorActions.ts` (`LucosSelectCustomizationAction`) + `listCustomizations` across daemon layers |
| **TW-198** Login | `common/lucosAuthService.ts`, `browser/lucosAuthService.ts`, `lucosLoginActions.ts` |

---

## Daemon contract (proto `lucos.v1.LucosDaemon`)

Consumed via `ILucosDaemonService`. All 12 RPCs are **implemented** on the daemon side (teammate
confirmed the local-daemon blockers are cleared).

| RPC | Used by | Daemon status |
|-----|---------|---------------|
| `Health` | status bar, connection polling | ✅ implemented |
| `GetAuthStatus` / `SetCloudCredentials` / `ClearCloudCredentials` | login, status | ✅ implemented |
| `StartAgentTask` (server-stream) | chat, timeline | ✅ implemented (real agent loop) |
| `GetPendingPatch` / `ApplyPatch` / `RejectPatch` | diff review | ✅ implemented |
| `ListCustomizations` | skill/agent picker | ✅ implemented |
| `IndexWorkspace` (server-stream) | index service, status bar, command | ✅ implemented |

Agent task-event kinds the UI renders: `task.started`, `model.delta`, `tool.started/completed`,
`patch.proposed`, `task.completed`, `auth.required/expired/forbidden`, `quota.exceeded`, `error`.

Index task-event kinds (from `IndexWorkspace`, folded by `ILucosIndexService`): `index.started`,
`index.progress`, `index.upload.started`, `index.upload.progress`, `index.cloud.status`,
`index.completed` (carries `status` + optional `cloud_state`), `index.failed` (`code` + `message`).

---

## Runtime-validation checklist

Everything below is typecheck-verified; daemon-dependent paths have **unit/integration tests** plus a
local E2E runbook. Once the native build is fixed (TW-155) and the daemon is running, verify manually:

**Local dev pre-reqs**
- Start the daemon: `make dev` — it writes `~/.lucos/daemon.json` (`grpc_port`, `local_session_token`).
- For agent chat without cloud `/api/v1/agent/turn`: `LUCOS_AGENT_TURN=mock make dev` in `local-daemon`.
- Point sign-in at the local gateway (TW-168): set `lucos.cloud.gatewayUrl` to `http://localhost:3007`
  (the setting defaults to the prod `https://stagingapi.lucos.com`; the daemon's own `LUCOS_GATEWAY_URL`
  is set via `local-daemon/.env`).
- Full indexing E2E: see [`docs/lucos-indexing-e2e-local.md`](../../docs/lucos-indexing-e2e-local.md).
- Full IDE↔daemon chat E2E (mock turn, read/create/edit, patch review): see
  [`docs/lucos-ide-daemon-e2e-local.md`](../../docs/lucos-ide-daemon-e2e-local.md).

- [ ] Fork builds & launches (`npm install` succeeds, `./scripts/code.sh` opens) — **blocked on TW-155 (native modules)**
- [ ] Lucos icon appears in the Activity Bar; `Ctrl/Cmd+Shift+A` focuses the chat view
- [ ] Settings show under "Lucos AI"; changing the model updates the status bar
- [x] `lucos.agent.model` and `lucos.agent.permissionMode` are sent on `StartAgentTask` (chat view)
- [ ] Status bar shows Connected + model when the daemon is up; Offline when it's down
- [ ] Sign in (TW-198) → gateway `POST /api/v1/auth/authenticate` with `{authType:'email', action:'sign-in', …}`
      returns a token → JWT lands in OS keychain → daemon `SetCloudCredentials` → status flips to authenticated
- [ ] Restart the IDE → session auto-restores from the keychain
- [ ] Chat: type → task streams tokens; Stop cancels; timeline shows tool activity
- [ ] `@selection` / `@file` / `@workspace` attach chips and reach the task request
- [ ] `patch.proposed` → review card → "view diff" opens a native side-by-side diff
- [ ] Accept → daemon `ApplyPatch` writes files; Reject → `RejectPatch` discards
- [ ] Cmd+K on a selection → prompt → edit task → patch review
- [ ] Palette: Explain / Refactor / Generate Tests / Review Changes start the right task
- [ ] "AI: Run Skill or Agent" lists customizations and runs the chosen one (TW-184)
- [ ] **Index (TW-220/169/170):** run "Lucos: Index Workspace" → request carries `workspaceId` +
      `ignore_patterns` (from `lucos.context.ignorePatterns`) → status bar shows `$(sync~spin) indexing…`
      → on completion flips to `· indexed` (or `· index stale (N)`) and an info notification fires
- [ ] **Index while offline (TW-220 AC):** with the daemon down, "Lucos: Index Workspace" shows a clear
      "daemon is offline" warning instead of failing mid-stream
- [ ] **Index failure (TW-172):** trigger a failure (e.g. sign out / no entitlement) → status bar shows
      `· index failed`, tooltip carries the message, and an error notification fires
- [ ] Kill the daemon mid-session → offline banner + debounced offline notification; restart → reconnects
- [x] `npm run test-browser --grep LucosDaemonServiceStub` passes (model/permissionMode + stream shape)
- [x] Daemon: `GOWORK=off go test ./internal/agentturn/ ./internal/agent/ ./internal/server/` passes
- [x] Proto anti-drift test: `platform/lucos/test/node/lucosProtoDrift.test.ts` (requires Node 24+ for `test-node`)

---

## Known follow-ups (marked `TODO(TW-…)` in code)

- **Cmd+K keybinding** — `Ctrl/Cmd+K` is a VS Code chord prefix; confirm no clash or move to a
  dedicated inline content-widget with its own key handling (`lucosEditorActions.ts`).
- **Markdown rendering** in chat — currently plain text; add `markdown-it`/Shiki (TW-159,
  `lucosViewPane.ts`).
- **Chat virtualization** — rAF batching is in; large-conversation virtualization is not (TW-173).
- **Proto bundling** — canonical subset lives in `platform/lucos/node/lucosEmbeddedProto.ts`; drift
  guarded by `platform/lucos/test/node/lucosProtoDrift.test.ts`. Consider shared `lucos-proto` package later.
- **Native diff** uses in-memory `contents` inputs; a registered content provider would allow
  lazy/shared models if needed later.

---

## Build & run

```bash
npm install                 # blocked on Windows native-module build (TW-155 / Rikin)
npm run watch               # incremental compile
./scripts/code.sh           # launch (macOS/Linux) · .\scripts\code.bat (Windows)
npm run typecheck-client    # tsgo typecheck — currently GREEN for all Lucos code
```

Dev mode connects to an externally-run daemon (see TW-205); the daemon writes its port + session
token to `~/.lucos/daemon.json`, which the client reads on connect.
