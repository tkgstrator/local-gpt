# Pro Recovery and Conversation Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover completed Pro answers without exporting reasoning recaps, and delete only the exact requested disposable conversation.

**Architecture:** Narrowly exclude the observed `reasoning_recap` intermediate in the shared stream/recovery visibility predicate. Bound sidebar action discovery to actual same-origin target conversation rows, retaining ambiguity and all deletion guards.

**Tech Stack:** TypeScript, Bun 1.3.11, happy-dom, Chrome extension, native ChatGPT receipts.

**Spec:** Latest user request to fix the remaining Pro result recovery and conversation deletion bugs; acceptance criteria below.

## Global Constraints

- Keep the single existing shared ChatGPT tab and never resend unknown jobs.
- No conversation bodies, hidden reasoning or authentication may be stored as diagnostic fixtures.
- Keep strict outgoing-user/branch correlation, draft/attachment/generation guards and successful native DELETE receipt requirements.
- No select-first behavior for distinct target action buttons; no expansion of filesystem mounts or permissions.
- Bump both extension version sources: 2.4.16 for the first release, then 2.4.17 for the native acceptance follow-up.
- Implementation worker must not commit/push; Codex verifies native tests and guarded Git policy.

## Review Focus

- Null or absent recap channel must not make an intermediate a public answer.
- A recap-only terminal and malformed real final must not become success.
- Hash/query/external links and shared ancestor wrappers must not select a neighboring conversation.
- Duplicate anchors for one action dedupe; genuinely distinct actions remain ambiguous.
- Existing draft, changed-route, active-generation and failed-receipt checks must remain effective in the built extension.

---

### Task 1: Pro output relevance

**Files:** `src/conversation-stream.ts`, `test/conversation-stream.test.mjs`, `test/native-response-recovery.test.mjs`.

**Interfaces:** Keep `isVisibleAssistantOutput(value)` and `conversationFinalOutput(value,cid,user,observed)` signatures; return only correlated final public text/images.

- [ ] Add regressions using synthetic assistant recap `{content_type:'reasoning_recap',content:'Private recap sentinel'}`, null/absent channel, recipient all, successful status and end_turn false, followed by a successful text final. Assert stream stop, only final text/node IDs, graph final output, no sentinel export; recap-only graph/stream never completes. Cover delta-v1 content/status updates, failed/cancelled recaps and a recap arriving after a finished final.
- [ ] Run the targeted native tests against unchanged production code and confirm the new cases fail for unsupported/recovery content, not harness errors.
- [ ] Exclude only `reasoning_recap` alongside `model_editable_context` in the shared predicate. Do not skip arbitrary unknown content or change final status/correlation semantics.
- [ ] Build and rerun targeted stream/recovery tests, including existing malformed-final, failed/cancelled, private context and branch tests.

### Task 2: Exact conversation action discovery

**Files:** `src/browser-projects.ts`, `src/browser-app.ts`, `test/browser-projects.test.mjs`, `test/browser-guards.test.mjs`.

**Interfaces:** Keep `conversationActions(doc,cid): HTMLButtonElement|null`, throwing `project_ambiguous` for genuinely distinct matching actions; keep `runDelete` receipt protocol unchanged.

- [ ] Add direct tests for skip/hash/query/external links, neighbor/shared wrappers, missing target action, duplicate anchors sharing one button and distinct duplicate rows. Assert exact button identity, null when no safe row, and ambiguity when multiple actual target buttons. Filtered foreign-CID links and non-conversation navigation links still establish ownership boundaries; support nested row buttons.
- [ ] Add built-extension deletion regression with skip anchor and neighbor, plus existing draft/active-generation protection. Confirm native receipt and exact target removal are required, neighbor remains untouched. Row reuse after actions/menu opening must block the next destructive click even when the active route remains the target.
- [ ] Run tests and observe expected failures before editing production.
- [ ] Parse raw same-origin URLs without hash/search, skip content/header links; bound ancestor traversal before any differently owned anchor, collect/dedupe nearest target actions, retain ambiguity. Do not introduce unconditional nav/aside dependence without live markup evidence. Revalidate the captured action's structural target ownership before menu deletion and final confirmation, allowing modal-hidden but not detached/reused rows; active header fallback must remain connected to main and the unchanged target route.
- [ ] Build and rerun project/browser guard tests; verify existing project migration remains safe because it shares the helper.

### Task 3: Integration, review and release verification

**Files:** `extension/manifest.json`, `src/userscript.header.txt`.

- [ ] Resolve independent LocalGPT conceptual and Claude file-aware plan review findings before production changes; report unavailable worker file access honestly.
- [ ] Bump extension version to 2.4.17 and run full `bun run test` (initial baseline: 371 pass, 0 fail).
- [ ] Request independent Claude actual-diff review, fix material findings and rerun verification.
- [ ] Apply fresh gh identity checks; commit with recognized AI credit, normal guarded push, PR CI and merge according to existing user authorization.
- [ ] Publish extension release and verify update of installed extension/server through existing updater workflow, preserving pairing and permissions.
- [ ] Start a fresh Pro smoke job once, collect through response_get until terminal, verify final-only result and busy release. Delete only saved disposable test sessions through MCP and verify exact native deletion result/metadata removal. Preserve useful review/evidence conversations until no longer needed.

## Implementation verification

Tasks 1 and 2: implemented and independently reviewed. Added 23 regressions; native Bun 1.3.11 full suite: 394 pass, 0 fail. Build/typecheck and formatting passed. Empty/whitespace href ownership was additionally reproduced RED, fixed and independently re-reviewed. Integration and live acceptance remain deployment gates.

### Native acceptance follow-up

The first native 2.4.16 acceptance run still failed. Read-only structural diagnostics confirmed an additional `thoughts` intermediate before `reasoning_recap`, and actual sidebar action depth 4 (outside the previous bound). The current header More is inside `data-testid="app-shell-header-context-menu-surface"`, not `main`.

Follow-up 2.4.17 excludes only the additionally observed `thoughts` type, extends bounded traversal to eight levels with foreign-link and semantic-row boundaries, and derives header lookup/ownership selectors from the same exact observed root list. Synthetic thoughts/recap/final, actual-depth and titlebar regressions must pass, then a temporary local build is tested natively before official release. Final deployment remains the verified GitHub Release package, with unchanged pairing and permissions.

Follow-up verification: standard native `bun run test` passed all 419 tests, build/typecheck/formatting passed, and independent actual-diff review found no blockers. Native Reload approval and acceptance remain pending; no native success is claimed from unit tests alone.
