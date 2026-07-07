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
│   └── lucosChatRequestService.ts             "submit to chat" seam (Cmd+K / palette → view)
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
│   ├── lucosEditorActions.ts                  Cmd+K + palette (Explain/Refactor/Tests/Review) + skill/agent picker
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
| **TW-161** gRPC Client | `platform/lucos/**`, `electron-browser/lucosDaemonServiceRemote.ts`, `electron-browser/lucos.contribution.ts`, `browser/lucos.stub.contribution.ts`, `app.ts`, mains, `package.json` |
| **TW-162** Activity Timeline | `lucosActivityTimeline.ts` |
| **TW-163** Cmd+K | `lucosEditorActions.ts` (`LucosCmdKAction`), `lucosChatRequestService.ts` |
| **TW-164** @mentions | `lucosContextPicker.ts`, `lucosViewPane.ts` (chips + threading) |
| **TW-165** Diff Viewer | `lucosPatchReview.ts` + patch RPCs across the daemon layers |
| **TW-166** Apply/Reject | `lucosPatchReview.ts` (accept→`applyPatch`, reject→`rejectPatch`) |
| **TW-167** Command Palette | `lucosEditorActions.ts` (Explain / Refactor / Generate Tests / Review Changes) |
| **TW-168** Settings | `lucos.contribution.ts` (`registerConfiguration`), `common/lucosConfiguration.ts` |
| **TW-169** Status Bar | `lucosStatusBar.ts` |
| **TW-170** Notifications | `lucosNotifications.ts` |
| **TW-172** Error Handling | `lucosViewPane.ts` (offline banner + auth/quota events) |
| **TW-173** UI Performance | `lucosViewPane.ts` (rAF-batched streaming updates) |
| **TW-174** Testing | `test/browser/lucosDaemonServiceStub.test.ts` |
| **TW-184** Customizations | `lucosEditorActions.ts` (`LucosSelectCustomizationAction`) + `listCustomizations` across daemon layers |
| **TW-198** Login | `common/lucosAuthService.ts`, `browser/lucosAuthService.ts`, `lucosLoginActions.ts` |

---

## Daemon contract (proto `lucos.v1.LucosDaemon`)

Consumed via `ILucosDaemonService`. Auth RPCs (TW-190/191/192) are **done** on the daemon side.

| RPC | Used by | Daemon status |
|-----|---------|---------------|
| `Health` | status bar, connection polling | ✅ implemented |
| `GetAuthStatus` / `SetCloudCredentials` / `ClearCloudCredentials` | login, status | ✅ implemented |
| `StartAgentTask` (server-stream) | chat, timeline | 🟡 skeleton (real agent loop pending) |
| `GetPendingPatch` / `ApplyPatch` / `RejectPatch` | diff review | ⬜ in proto; verify daemon impl |
| `ListCustomizations` | skill/agent picker | ⬜ in proto; verify daemon impl |

Task-event kinds the UI renders: `task.started`, `model.delta`, `tool.started/completed`,
`patch.proposed`, `task.completed`, `auth.required/expired/forbidden`, `quota.exceeded`, `error`.

---

## Runtime-validation checklist

Everything below is typecheck-verified but **not runtime-tested**. Once the native build is fixed
(TW-155) and a daemon is running (`opencode`/`lucos-daemon` in dev mode), verify:

- [ ] Fork builds & launches (`npm install` succeeds, `./scripts/code.sh` opens) — **blocked on TW-155 (native modules)**
- [ ] Lucos icon appears in the Activity Bar; `Ctrl/Cmd+Shift+A` focuses the chat view
- [ ] Settings show under "Lucos AI"; changing the model updates the status bar
- [ ] Status bar shows Connected + model when the daemon is up; Offline when it's down
- [ ] Sign in → JWT lands in OS keychain → daemon `SetCloudCredentials` → status flips to authenticated
- [ ] Restart the IDE → session auto-restores from the keychain
- [ ] Chat: type → task streams tokens; Stop cancels; timeline shows tool activity
- [ ] `@selection` / `@file` / `@workspace` attach chips and reach the task request
- [ ] `patch.proposed` → review card → "view diff" opens a native side-by-side diff
- [ ] Accept → daemon `ApplyPatch` writes files; Reject → `RejectPatch` discards
- [ ] Cmd+K on a selection → prompt → edit task → patch review
- [ ] Palette: Explain / Refactor / Generate Tests / Review Changes start the right task
- [ ] "AI: Run Skill or Agent" lists customizations and runs the chosen one
- [ ] Kill the daemon mid-session → offline banner + debounced offline notification; restart → reconnects
- [ ] `npm run test-node --grep LucosDaemonServiceStub` passes

---

## Known follow-ups (marked `TODO(TW-…)` in code)

- **Cmd+K keybinding** — `Ctrl/Cmd+K` is a VS Code chord prefix; confirm no clash or move to a
  dedicated inline content-widget with its own key handling (`lucosEditorActions.ts`).
- **Markdown rendering** in chat — currently plain text; add `markdown-it`/Shiki (TW-159,
  `lucosViewPane.ts`).
- **Chat virtualization** — rAF batching is in; large-conversation virtualization is not (TW-173).
- **Proto bundling** — the daemon proto is embedded + written to a temp dir at runtime; consider
  static codegen or a shared `lucos-proto` package to stay in sync with the daemon
  (`platform/lucos/node/lucosGrpcClient.ts`).
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
