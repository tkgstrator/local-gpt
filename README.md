# LocalGPT

ログイン済みのChatGPTを開いたホストのChromeを、ローカルのResponses APIとMCPから利用するサービスです。Bun + TypeScript + Zodで実装し、ブラウザー側はChrome拡張機能またはTampermonkeyスクリプトへビルドします。

同じマシンのCodex Desktopから使う場合、登録するMCPはLocalGPTの1つで構いません。DockerのLocalMCPサイドカーを組み合わせると、チャット操作とファイル・コマンド操作を同じMCPの入口から利用できます。サービスをインターネットへ公開する必要はありません。質問やファイルの内容をChatGPTへ送った場合は、通常どおりChatGPTへの通信が発生します。

## 構成

- ホスト: ログイン済みChatGPTを開いたChromeとLocalGPT拡張機能。
- LocalGPT: Responses API、SSE、MCP、モデル情報、セッション管理、ブラウザー接続。
- LocalMCP: Rust製Dockerサイドカー。共有作業フォルダーの読み書き・検索・コマンド実行。
- Codex Desktop: LocalGPTのMCPへ接続し、必要な道具を選んで作業を進めます。

## Dockerサイドカーで起動

Docker Composeだけで起動できます。リポジトリのclone、ホストのBun、セットアップスクリプトは不要です。

```sh
curl -fsSLO https://raw.githubusercontent.com/tkgstrator/local-gpt/master/compose.yaml
docker compose up -d
```

Composeが公開イメージを取得し、接続キーの初期化、LocalMCP、LocalGPTの順に起動します。初期化用コンテナは成功後に終了します。接続キー・セッション・LocalMCPの状態・共有作業フォルダーはDockerの名前付きボリュームに保存され、再起動後も維持されます。初回起動時に、このインストール専用の接続キーを使った拡張機能をコンテナ内で生成します。

[ローカルダッシュボード](http://localhost:8766/)を開き、拡張機能ZIPをダウンロードして展開します。ホストのChromeの`chrome://extensions/`でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から展開したフォルダーを選びます。ログイン済みのChatGPTを再読み込みし、ダッシュボードでサーバー・ブラウザ・リクエスト・ファイル操作の4つの状態を確認してください。

### 拡張機能の更新

拡張の新しいバージョンは、CI成功後にGitHub Releasesの `extension-vX.Y.Z` として公開されます。公開ZIPにはローカル認証キーを含めません。更新ツールはGitHubのSHA-256ダイジェストでZIPを検証し、インストール済みの接続設定を保持して入れ替えます。

macOSでは、Releaseの `update-extension.mjs` を保存し、Node.js 22以降またはBunで一度セットアップします。引数にはChromeで読み込んでいるLocalGPTのフォルダを指定します。初回のみ、起動中のローカルサーバーの配布ZIPから接続設定を移行できます。

```sh
node update-extension.mjs --install "/absolute/path/to/installed/LocalGPT"
node update-extension.mjs
```

二回目以降は引数なしで更新を確認します。このコマンドをmacOSのLaunchAgent等で定期実行できます。Chromeが登録したフォルダーと拡張IDを保持し、その内部のファイル参照を一括で切り替えます。以前のファイルはロールバック用に残ります。拡張はディスク上の新バージョンを検出し、生成・下書き・添付のない状態で再読み込みします。権限が増える更新は自動適用せず、手動承認を求めます。

```sh
docker compose logs --tail=100
docker compose stop
# イメージを更新して再起動
docker compose pull
docker compose up -d
```

`docker compose down -v`は接続キーやセッション、共有ファイルも削除します。通常の停止には`stop`を使ってください。ホストのソースコードを共有する場合は、コミットしない`compose.override.yaml`で両サービスに同じbind mountを追加します。LocalMCPのパスはsandboxルートからの相対パスなので、`local-gpt/src/server.ts`のように指定します。既存の共有ボリュームは保持します。ファイル不在などの入力エラーは`localmcp_tool_error`と元のエラーコード・説明で返し、通信失敗など実行結果が不明な場合は`localmcp_call_failed`として自動再送を避けます。

## Codex Desktopから利用

Streamable HTTP対応クライアントには次を登録します。

```text
http://127.0.0.1:8766/mcp
```

Dockerだけでの利用には上記のHTTP接続を使います。ソースから開発する場合は、stdio向けの`dist/mcp-config-fused.json`も生成できます。LocalMCPを別途登録する必要はありません。`localgpt_*`がChatGPT操作を、`localmcp_*`がファイル・コマンド操作を担当します。

ファイル操作はLocalMCPを使います。LocalGPTへファイルの調査や要約を任せる場合は、本文をチャットへ貼り付けず、LocalMCPから見えるパス・必要な行範囲・質問だけを渡します。ChatGPT側の会話でもLocalMCP専用のプラグイン接続を有効にして、ChatGPT自身が対象ファイルを読みます。Codex側でLocalMCPを呼べることは、ChatGPT側の接続を確認したことにはなりません。

### Codex Custom Instructionsのプロンプト例

LocalGPTを普段の作業でも優先して使わせたい場合は、次の指示をCodexのCustom Instructionsへ貼り付けてください。特定のリポジトリだけに適用したい場合は、そのリポジトリの`AGENTS.md`にも記載できます。

```text
Use LocalGPT proactively for routine analysis and creative work. Use LocalMCP
for workspace file operations. Apply these defaults without waiting for the
user to explicitly request either tool on each task.

Task routing:
- Use LocalMCP (localmcp_*) to list, search, read, write, and edit files.
  If LocalMCP cannot access the files, report the access/setup issue. Do not
  silently switch to shell commands or Codex file tools for file operations.
- For summaries, explanations, requirement extraction, specification comparisons,
  and reviews, send LocalGPT short requests containing LocalMCP-visible file
  paths, optional line ranges, concrete questions, and expected output.
  Tell the ChatGPT worker to read those files through its own enabled LocalMCP
  tools. Resolve shared workspace paths through LocalMCP; do not invent paths.
- Never paste full file contents, large code blocks, diffs, or logs into LocalGPT
  messages or instructions. File references must use LocalMCP. Do not use inline
  file text or attachments as an automatic fallback.
- The ChatGPT worker must have its LocalMCP-only plugin enabled in the target
  conversation and actually be able to read the requested paths. The caller
  having localmcp_* tools or a healthy gateway does not prove worker access.
  If worker access is unavailable, report the setup issue and stop the dependent
  delegation; do not paste the files, attach them, or claim a file-based review.
- Delegate web research, document drafting, translation, UI/UX ideas, layout
  proposals, design alternatives, and image generation to LocalGPT.
- Delegate code reviews, diff reviews, specification reviews, and UI/UX
  reviews to LocalGPT. Provide file paths, revision references or line ranges,
  a brief statement of requirements, and review criteria. Have the worker read
  the files or diff through LocalMCP and cite concrete locations as evidence.
- For small changes, ask LocalGPT for the proposed edits and apply them with
  LocalMCP. A proposed edit is not proof that the file was changed: verify the
  actual file after writing.
- Codex handles task coordination, complex implementation, difficult debugging,
  changes spanning multiple components, and final verification. Even when
  Codex implements a complex change, use LocalGPT for an independent review
  when it has access to the necessary context. Check its findings before
  applying changes, and verify the final result with appropriate checks.

Parallel work and ownership:
- Use Codex subagents for independent tasks when useful. Assign each subagent
  a concrete outcome and an explicit set of files or areas it owns.
- Each subagent should use LocalMCP for its assigned files and LocalGPT for
  analysis, summaries, UI proposals, and reviews. Give each independent topic
  its own LocalGPT session. Coordinate all LocalGPT browser operations through
  a single parent-managed schedule; send one request at a time service-wide.
- Codex subagents may work in parallel, but LocalGPT browser requests, including
  model and capability reads, must run sequentially across all sessions and tabs.
  Check localgpt_status first. availableBrowsers is at most 1; when it is 0 or
  busy is true, wait without sending or switching chats. A 409 browser_busy means
  the operation was rejected before dispatch; retry it only after the active
  operation completes. Additional Chrome tabs or windows do not increase capacity.
- Before starting delegated work, retrieve localgpt_capabilities, await its
  result, then retrieve localgpt_models. Decide which model and reasoning effort
  fits each task. Include that allocation in each subagent's assignment.
- Keep file writes disjoint. Assign a single owner to shared files and let
  the parent Codex agent coordinate dependent changes and integrate results.
- Have subagents report their session IDs, files changed, conclusions, and
  validation results to the parent agent. The parent verifies the combined
  result and decides when task conversations can be cleaned up.

Conversation organization:
- Prefer a dedicated ChatGPT project named LocalGPT, or the user's chosen
  project, for LocalGPT task conversations. New LocalGPT sessions default to this project.
  Keep separate conversations for each task or subagent within that project.
- Give sessions descriptive titles such as "repository / task / UI review".
  Include task-specific context in each request rather than relying on other
  project conversations as an implicit handoff between agents.
- Use localgpt_session_project to move an existing managed conversation without
  sending a message. Preserve its conversation ID and wait for confirmed project
  membership. Never move unrelated user conversations.

LocalGPT workflow:
- Before executing a task, check localgpt_status. Retrieve
  localgpt_capabilities and localgpt_models sequentially, then assess the models.
  Use capabilities.choices for executable model IDs and effort combinations;
  localgpt_models provides display labels, not authoritative model IDs.
- Plan model allocation before sending requests. Prefer faster available
  models for simple searches, summaries, and small edits. Prefer stronger
  reasoning models for difficult analysis, complex UI proposals, and demanding
  reviews. Assign heavy tasks to Astra when it is actually available in the
  retrieved choices. Do not invent an Astra ID or equate Pro/Thinking with Astra.
  If Astra is unavailable, select a suitable observed alternative and briefly
  explain the choice. Choose effort according to the task's difficulty.
- Create a session with localgpt_session_create for each topic, specifying
  the selected model and supported effort where applicable. Reuse its
  session_id for follow-up localgpt_respond calls. Recheck availability if
  model selection fails or the available choices change.
- Give LocalGPT a concrete task, concise context, constraints, and expected
  output. Reference files by LocalMCP-visible paths and relevant ranges; the
  worker reads them with LocalMCP. Do not transmit file contents as prompt text
  or use attachments to bypass a missing worker connection.
- Request source URLs for web research. For reviews, request affected locations,
  severity, rationale, and actionable suggestions; Codex verifies the findings.
- Display generated images using the saved original file paths returned by
  LocalGPT. Do not substitute screenshots for the original images.
- Pro requests return a response job ID. Other requests also return a job ID
  when unfinished after a 25-second SSE wait, including model-unspecified calls. Await localgpt_response_get until its
  status is completed or failed; a job receipt is not the answer. This tool
  waits for SSE events for up to 25 seconds and returns immediately on
  completion. If still in_progress, call it again immediately without sleeps.
  Use wait_ms:0 only when an immediate snapshot is needed. Use
  localgpt_response_start or background:true for other long tasks as needed.
  thinking means native API reasoning activity was observed. unresponsive means
  no recent API activity and an unknown state, not confirmed termination.
  Do not resend or start another browser operation while the job is in progress.
- Preserve manual drafts and attachments. After a timeout or disconnect, check
  whether the request was sent before proceeding; do not automatically resend.
- Once a conversation created for this task is no longer needed and its useful
  output is saved, explicitly decide whether to delete it with
  localgpt_session_delete, if available. Do not delete pre-existing user chats
  or perform age-based bulk cleanup.
- Reuse one existing ChatGPT browser tab for all LocalGPT sessions. A new
  LocalGPT session is a conversation, not a new browser tab. Do not open tabs
  or Chrome windows per task, model, session, or subagent. Let the extension
  switch conversations in the existing tab. Subagents must share this tab
  through the parent-managed sequential schedule. If no connected tab exists,
  report the setup issue instead of opening more tabs autonomously.
- Use LocalGPT MCP tools for routine ChatGPT operations. Do not autonomously
  start Computer Use, browser automation, or direct ChatGPT tab manipulation
  to inspect, repair, or bypass LocalGPT. Let the extension manage navigation.
- If LocalGPT is unavailable, busy, or fails, use its structured status and error
  results. Report any required extension reload or login to the user. Never
  turn a routine LocalGPT failure into a Computer Use session; use Computer Use
  only when the user explicitly requests or authorizes browser diagnosis.
- If LocalGPT cannot handle a non-file task, briefly explain the limitation
  and continue with suitable Codex reasoning or research tools. For file work,
  keep using LocalMCP; if it is unavailable, report the setup/access issue and
  wait for resolution or explicit user instructions. Do not silently bypass
  LocalMCP with file tools, shell reads, inline text, or uploads. This fallback
  does not authorize Computer Use.
```

この例では、CodexとChatGPTの両方がLocalMCPを使います。ChatGPT側でもLocalMCP専用の接続を追加し、対象の会話で有効にしてください。Codex側のLocalMCP接続だけではChatGPTからファイルを読めません。ファイル本文・長いコード・diff・ログはLocalGPTへの依頼文に貼り付けず、パスや行範囲で参照します。接続できない場合は設定上の問題として報告し、本文貼り付けや添付へ自動で切り替えません。LocalGPTの接続先をChatGPT自身へ登録すると再帰呼び出しになるため、ChatGPT側にはLocalMCP専用の接続先を使ってください。

Codexのサブエージェントは並行作業できますが、LocalGPTのブラウザー操作はサービス全体で常に1件ずつです。生成だけでなく、モデル・capabilitiesの取得、dots操作、会話削除も同じ実行枠を使います。処理中の追加依頼は送信前に`409 browser_busy`で拒否します。複数のChromeタブやウィンドウを開いても実行枠は増えません。複数のCodex・全セッションで、サーバーが選んだ既存のChatGPTタブ1枚を共有します。ほかのタブは待機し、選択中のタブが接続されている間は操作を受け取りません。切断された場合だけ別の既存接続へ切り替え、処理中の要求は移動・再送しません。`localgpt_status`の`sharedBrowserId`で共有接続を確認できます。新しいセッションは既定でChatGPTの`LocalGPT`プロジェクト内に作成します。`projectName`で別のプロジェクトを指定でき、`null`で集約を無効にできます。既存のLocalGPT管理セッションは継続時に同じプロジェクトへ移動します。メッセージを送らずに移動する場合は`localgpt_session_project`に`session_id`を渡します。移動は会話IDを維持し、ChatGPTの移動API成功を確認してから記録します。管理対象外の会話は移動しません。[ChatGPTのプロジェクトと会話の説明](https://learn.chatgpt.com/docs/projects)も参照してください。

入力は拡張機能内のJSからブラウザーの入力コマンドを呼び出します。contenteditableの本文を`textContent`で置き換えるフォールバックは行わず、入力コマンドが使えない場合は送信前にエラーを返します。textareaはネイティブの値setterとinputイベントを使います。モデル選択は拡張機能のJSからChatGPTの既存`onModelChange`関数を一度呼び、モデル・思考強度・バージョンをまとめて設定します。選択状態が一致したことを確認してから送信します。メニューのクリック・矢印キー操作や送信APIのモデル欄の書き換えは行いません。内部関数を取得できない場合はエラーを返し、UI操作へ自動で切り替えません。

MCPのHTTP接続と回答取得はSSEに対応しています。通常の`localgpt_respond`もジョブのSSEを最大25秒待ち、進捗通知を要求したMCPクライアントへ回答の差分を通知します。25秒以内に完了した場合は回答を返し、未完了なら継続取得できるジョブIDを返します。モデル未指定の場合も同じ上限です。Codexのチャット欄へ途中の本文が表示されるかはクライアント側の対応に依存します。

Proモデルは非同期ジョブで実行し、`localgpt_response_get`がSSEで状態・回答差分・完了イベントを待ちます。MCPの各取得呼び出しは`wait_ms`既定25,000（最大）で、完了時は待ち時間を残さず返します。まだ処理中なら間隔を空けずに再度呼びます。`wait_ms:0`は即時の状態取得です。HTTPでは`GET /v1/response-jobs/{id}/events?wait_ms=25000`で同じイベントを購読できます。接続開始時に現在の状態と取得済みの本文を返し、購読が切断されても生成は継続します。非同期生成自体には経過時間による打ち切りを設けません。APIが思考中・回答中を通知した場合はその状態を記録し、10分間通信がない場合は`unresponsive`（状態未確認）とします。この状態でも実行枠を維持します。明示的な失敗・キャンセルと、取得タイムアウト・通信切断を区別し、自動再送しません。

## APIとセッション

```sh
curl -N http://127.0.0.1:8766/v1/responses \
  -H 'Content-Type: application/json' \
  --data '{"input":"こんにちは","stream":true}'
```

`POST /v1/sessions`で話題ごとのセッションを作り、返されたIDを`session_id`に指定して会話を続けます。異なるセッションもサービス全体で1件ずつ処理します。すべての呼び出しは、サーバーが選んだ既存の共有ChatGPTタブ1つに送られ、ほかの接続は待機用で、共有タブの接続が切れた場合だけ引き継がれます。処理中に別の操作を送ると`409 browser_busy`で送信前に拒否され、処理中の要求を別タブへ移動・再送しません。モデルとreasoningは、観測された利用可能な選択肢から指定します。通常のプレーンテキスト下書きは保存・退避してから送信し、新しい手入力は上書きしません。添付や安全に保存できない下書きは保護します。

送信前は対象会話と手動下書きを確認します。送信後は会話ID・メッセージIDで識別したAPI応答をイベント駆動で直接転送し、100msタイマーでの回答確認は行いません。HTTP通信の応答待ちに溜まった未送信の回答は最新本文へまとめ、最終本文の後に完了を送ります。このため、同じタブ内で別のChatに切り替えても通信が継続していれば応答を取得できます。リロード・タブ終了などで通信が途切れた場合は失敗として報告し、自動で再送しません。

不要になったセッションは、Codexから`localgpt_session_delete`に`session_id`を指定して削除できます。対応するChatGPT会話も削除し、対象の会話IDへの削除API通信が成功したことを確認してからローカルのセッション情報を消します。会話がまだ作られていないセッションはローカル情報だけを削除します。処理中のセッションや手動の下書き・添付があるタブでは削除しません。会話の削除は元に戻せません。自動で期限を決めて削除する機能はありません。

画像生成も`localgpt_respond`へ通常の文章で依頼できます。生成画像は最大4枚・各8 MiBのPNG/JPEG/WebP/GIFに対応し、MCPは画像と`images`内の保存パスを返します。Responses APIの結果にも`images`を追加し、`GET /v1/images/{id}`で保存した画像を取得できます。ストリームでは保存後に`response.image.saved`と完了通知を返します。保存画像はセッション・会話の削除後も残ります。

画像は生成応答のファイルIDと照合して取得します。画像データがID通知より先に届いても保持し、観測済みのChatGPT内の取得URLがあれば、画面の画像読み込みを待たずに取得します。生成要求の失敗はDockerログに`generation_failed`として要求ID・エラーコード・受信状況を記録します。本文・画像・認証情報・取得URLはログに含めません。

Dockerでは画像を`/workspace/localgpt-images`に保存します。ホストへ保存する場合は、コミットしない`compose.override.yaml`で任意のディレクトリをバインドしてください。`LOCALGPT_IMAGES_DIR`で保存場所、`LOCALGPT_IMAGES_HOST_DIR`でクライアントに返すホスト側の絶対パスを設定できます。今回の送信で生成された画像IDに対応する原本だけを取得します。CDNの画像URLに加え、認証付き `/backend-api/estuary/content` ではChatGPT自身の画像応答を複製して原本データを渡します。認証ヘッダーや署名付きの内部URLはサーバーに渡さず、CDNのURLも保存しません。ダウンロードできない場合は失敗とし、自動で再生成しません。

Responses APIはテキストと生成画像に対応しています。回答本文はChatGPTが送信したAPI応答のSSEを読み取り、本文の差分を返します。完了はAPIの成功状態と終了通知で確認し、画面の文章や生成表示からは判定しません。内部の思考・ツール通信は回答本文に含めず、通信切断や未対応の形式はエラーとして返します。ChatGPTのUI変更や接続切断で失敗する場合があり、タイムアウトした送信は自動で再送しません。

## 非同期ジョブAPI

ProモデルのようにChatGPTの応答が長時間かかる依頼は、非同期ジョブで扱います。

```sh
# 即座に202とジョブ受付を返す（応答本文ではない）
curl -s http://127.0.0.1:8766/v1/response-jobs \
  -H 'Content-Type: application/json' \
  --data '{"input":"長いレビューをお願いします","model":"gpt-6-pro"}'
# 状態の取得
curl -s http://127.0.0.1:8766/v1/response-jobs/<id>
# SSEで更新を待つ。wait_msは1〜60000ミリ秒
curl -N 'http://127.0.0.1:8766/v1/response-jobs/<id>/events?wait_ms=25000'
```

- `POST /v1/response-jobs`はストリーミングなしのResponsesリクエストを受け付け、ブラウザーが空いていれば`202`でジョブを返します。ブラウザー使用中は`409 browser_busy`です。
- ジョブは`in_progress`のあいだサービス全体のブラウザー枠を占有し、完了または失敗で解放されます。HTTPクライアントが切断してもジョブは続きます。
- 送信後の経過時間による打ち切りはありません。ChatGPTの応答はネイティブのレスポンスストリームで観測し、画面表示が落ち着いただけでは完了としません。送信前の準備には上限があり、準備に失敗した場合は枠を解放して失敗にします。
- `phase`は`processing`/`thinking`/`answering`/`unresponsive`です。`unresponsive`は最近のネイティブ通信がなく結果が**不明**という意味で、停止の証明ではありません。途中までの本文は保持されます。
- ブラウザー切断、サーバー再起動、ストリームの途切れ・未対応形式は失敗にせず、不明のまま枠を確保します。自動で再送しません。送信後はChatGPT自身が失敗・キャンセルを明示した場合だけ`failed`になります。
- 完了結果は1時間で期限切れになり、最大100件を保持します。

MCPでは`localgpt_response_start`と`localgpt_response_get`（待機は最大25秒、完了すると即座に返る）を使います。`localgpt_respond`はProモデルまたは`background:true`のときジョブ受付を即座に返します。それ以外の要求はSSEを最大25秒待ち、完了すれば本文を返し、未完了なら同じジョブを続けるための受付を返します。リモート生成を取り消すツールはありません。

### 永続化

Composeは既存のLocalGPT状態ボリュームに`LOCALGPT_RESPONSE_JOBS_DIR=/var/lib/localgpt/response-jobs`を設定します。ディレクトリは`0700`、ファイルは`0600`で、途中本文と結果を保存し、`instructions`と入力は保存しません。未設定の場合、ジョブはメモリ内だけで再起動で失われます。再起動後に未完了だったジョブは`unresponsive`（結果不明）として復元され、ブラウザー枠を確保し続けます。自動の再開・再送はしません。

保存失敗はジョブの`persistenceError`に表示します。メモリ内の状態・結果は取得でき、保存先が回復すると再保存します。初回保存ができない要求は送信前に拒否します。

### 入力欄の下書き

空の装飾付きProseMirror段落は空欄として扱います。通常のテキスト下書きは、元の会話と本文をこのタブの`sessionStorage`に保存して確認してから入力欄を空にし、完了後に元の会話の空欄へ復元します。新しい手入力は上書きしません。別の会話の下書きは右下の保存一覧から元の会話へ戻して復元、または本文をコピーできます。タブを閉じると保存領域も失われるため、必要な下書きは先に回収してください。リッチテキスト・添付・保存失敗・内容の競合がある場合は下書きを保持して送信を止めます。

### 拡張機能の更新

ネイティブストリームの観測には拡張機能2.4.14以降を使用してください。同じ2.4.13で異なるビルドが配布されたため、2.4.14で区別します。更新ツールを設定済みなら安全なタイミングで自動更新されます。手動更新では`/extension`から再取得して読み込み直し、ChatGPTを再読み込みしてください（Tampermonkey版も同様）。古い拡張機能では非同期ジョブは結果不明のまま残る場合があります。

### 不明なジョブの手動復旧

サーバーはリモートのキャンセルを行いません。`unresponsive`のまま回復しないジョブは、次の手順で人が復旧します。

1. LocalGPTを停止します（`docker compose stop localgpt`）。
2. ChatGPTを開き、生成中でないこと（待機状態）を目視で確認します。生成中なら停止または完了を待ちます。
3. `localgpt-state`ボリュームの`response-jobs`と`sessions.sqlite`のバックアップを取ります。
4. 該当ジョブの`<id>.json`を削除します。必要な途中本文は先に控えます。
5. ChatGPTの同じタブを再読み込みし、古い観測処理を終了します。入力途中の文章や保存した下書きは先に回収してください。
6. LocalGPTを再起動します。

ChatGPT側の生成を取り消したとは見なしません。必要ならChatGPT上で手動で確認してください。

詳しい機能・制限は[ローカル利用ガイド](README.local.md)、共有フォルダー・移行・起動方法は[サイドカー利用ガイド](README.sidecar.md)を参照してください。

## 開発

開発にはBun 1.3.11以降を使用します。

```sh
bun run check
bun run typecheck
bun run test
```

VS Codeでは「Reopen in Container」で編集・テスト環境を起動できます。Dev Containerと本番サービスのComposeは別です。ホストChromeへ接続するサービスはホストからルートの`compose.yaml`で`docker compose up -d`を実行してください。Dev Container内のlocalhostはホストのlocalhostとは異なります。

Dev Containerはホストの設定ディレクトリをマウントします。初回起動前に、存在しないディレクトリを作成してください。

```sh
mkdir -p ~/.aws ~/.claude ~/.codex ~/.ssh ~/.config/gh
```

## 由来とライセンス

[zsodur/chatgpt-api-by-browser-script](https://github.com/zsodur/chatgpt-api-by-browser-script)を出発点に、TypeScript、Bun、Responses、MCP、拡張機能、セッション管理を追加した派生実装です。アプリケーションのライセンスはISCです。第三者の著作権・ライセンスについては[第三者ライセンス表示](THIRD_PARTY_NOTICES.md)を参照してください。

### Long-running response jobs

`localgpt_response_start` and all MCP response jobs have no elapsed generation deadline.
`localgpt_response_get` waits for at most 25 seconds per call; continue polling the same job ID.
Ending a poll or disconnecting an MCP client never cancels ChatGPT generation.
The synchronous HTTP response deadline remains bounded by `REQUEST_TIMEOUT_MS`; browser setup
and dispatch observation also remain bounded independently from generation.

Set `LOCALGPT_RESPONSE_JOBS_DIR` to a private durable directory (the sidecar uses
`/var/lib/localgpt/response-jobs` in its existing state volume). Records are atomic JSON
files with mode 0600 in a 0700 directory, capped at 32 MiB each and 100 retained jobs.
They contain job metadata, partial answer text and terminal answers, never prompts or hidden
reasoning. Completed/failed records expire one hour after their terminal update and are
removed on subsequent job access or admission. Active jobs never expire or get evicted.
Without this setting, records remain memory-only and restart loses them.

An interrupted browser connection or incomplete native stream leaves the outcome unknown.
The job remains `in_progress` / `unresponsive`, retains partial answer text and reserves the
single shared browser slot. Bridge reconnection can replay observed answer/image/completion
events; it never sends the prompt again. A restarted pending job reserves the slot and requires
manual recovery: inspect its original ChatGPT conversation and ensure generation has finished
before clearing its private pending record and restarting the service. No remote model stop or
automatic retry is implied. Native confirmed completion/failure/cancellation releases the slot.
Updating the browser observer requires manually reloading the installed extension and the
existing ChatGPT tab after replacing its built extension files.
