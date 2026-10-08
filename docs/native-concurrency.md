# Native generation ownership

Native requests use one existing ChatGPT tab without driving the manual composer. The wire protocol is opt-in: an owning browser answers `native_readiness` with `native_ready` (`protocol: 1`). Old clients retain serial browser operation handling. A native-capable browser that reports unavailable must not fall back to a synthetic send.

The native lifecycle distinguishes preparation from possible remote dispatch:

1. Validate the requested target, model/effort, project, builder and upload contracts; prepare a native user message with the server-preallocated `nativeUserMessageId`.
2. Obtain the server's checked durable `native_intent` ACK before requesting page dispatch. Page dispatch also checks its session-storage journal. Lost acknowledgements permit receipt replay, not another generation submission.
3. Persist and acknowledge `native_identity` receipts. `clientThreadId` is a local identifier, **not** a server conversation UUID. Only a validated server `conversationId` can bind a session.
4. Forward bounded images and correlated response output. Native acceptance promises and completion callbacks do not prove remote termination. Release ownership only after proven pre-dispatch refusal or exact correlated terminal stream/graph evidence.

Independent native sessions/CIDs may overlap. Session/CID conflicts remain excluded, including unknown outcomes. Mutating browser UI/setup and extension reload remain excluded while native generations may be affected. Legacy unknown work remains conservatively reserved.

Selection of the shared tab applies to new requests. A connected selected tab remains selected. If it disconnects, another existing connected tab may handle new independent native requests after its own readiness handshake, even while the original tab owns unknown native jobs. Prefer a native-ready replacement when available. Legacy/UI pending or queued work still pins its original tab through navigation and reconnection.

Each native job keeps its original browser ID, user-message ID, session/CID reservations and receipt ownership. Selection changes never move or replay its dispatch. Its original browser may reconnect and deliver correlated receipts without displacing the selected connected tab. Unknown jobs continue to reserve their own session/CID and block browser mutations and extension reload; they do not block unrelated native sessions on the replacement.

## Native contract and verification

The production resolver discovers the cached ChatGPT completion, uploader, pure builder and conversation refetch functions from observed same-origin assets. It selects the current React composer store by raw-scope and query-client identity. Ambiguous, stale or missing contracts refuse before dispatch. Runtime asset hashes and module IDs are not pinned.

Asset observation begins at document start and resumes after BFCache restoration. Idle or interrupted native streams recover through the verified authenticated SDK refetch, with exact request/user/CID ownership. Recovery does not wait for local async status to become idle: the snapshot may be needed to discover remote completion. SDK refetch can update native keyed state; its session guards and merge behavior remain in effect. Raw graphs and credentials stay in page-world closures.

Native intent and refusal notifications replay until durable acceptance without repeating generation dispatch. A native POST header stall uses the same owned SDK recovery after the idle threshold; an unbound conversation remains pending until validated identity arrives.

Recovery waiters have a 15-second bound, while an underlying read retains its single-flight slot until settlement. Refused and disarmed preparations cannot restore payloads after an await. Terminal ACK/disarm releases local recovery resources and cancels only the observer's response clone and timers, preserving the native consumer and generation.

Uploads carry the request's observed model/version, project and user-message identity. Existing conversations use native keyed refetch and a validated idle, visible terminal text parent. Other parent/admission shapes refuse until their native contracts are verified. Native prepared objects preserve every field and explicit user UUID; the manual composer and attachments are not used.

Health reports `nativeReady`, `activeGenerations` and `canStartIndependentGeneration`. `busy` still reports any owned browser work; callers may start a different native session when `canStartIndependentGeneration` is true. Sequential model/capability observations remain available during native generations. Browser mutations and extension reload wait until all native generations resolve.

Source tests include the connected dispatcher → observer → browser → server A/B path, identity/persistence/ACK faults, uploads and legacy clients. They use mocked native functions and do not prove live concurrency. Live validation and actual-diff review must be recorded before this change is called complete.

Image completion still requires every correlated image to be saved before terminal ACK. If native download metadata is unavailable, recovery remains pending rather than omitting an image. Unplanned page loss can discard page-local recovery ownership; persisted unknown server jobs remain reserved and must not be resent.

Model and reasoning effort are resolved as a pair. Explicit request settings take precedence. A session's saved effort is inherited only for the same saved model; switching models without an explicit effort lets the native selector use its observed choice and still refuses ambiguous choices. On successful binding, a model change clears the previous model's effort from session metadata. Pre-dispatch refusals preserve the previous session settings.

Existing conversations admit an async state of `null` or the observed SDK numeric `4` (`UNREAD`). Unread status alone proves no completion: the current parent must independently pass the existing visible final text, successful status and end-turn checks, with exact CID/UUID/project and writable, unarchived admission. Other states remain refused. Preparation does not mark the conversation read or alter its async state.
