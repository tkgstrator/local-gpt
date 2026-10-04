> このガイドはソースからBunで開発・実行する場合の手順です。通常のDocker利用は、[READMEのComposeだけで起動する手順](README.md#dockerサイドカーで起動)を使用してください。

DockerサイドカーでLocalMCPと一緒に使う場合は [README.sidecar.md](README.sidecar.md) を参照してください。

# LocalGPTの使い方

この版ではブラウザー側をTypeScript + Zodで記述し、esbuildでTampermonkey用のJavaScriptへビルドします。サーバー側もTypeScriptへ移行しています。

## 起動

Bun 1.3.11以降を使用してください。

```sh
bun install --frozen-lockfile
bun run start
```

`bun run start` は型チェックとビルド後、サーバーを起動します。APIは `http://localhost:8766/v1/responses`、WebSocketは `127.0.0.1:8875` です。通常はループバックのみで待ち受けます。

## Chrome開発用拡張機能への導入

1. `bun run build` で生成した `dist/extension` フォルダーを使います。
2. Chromeで `chrome://extensions/` を開き、「デベロッパーモード」を有効にします。
3. 「パッケージ化されていない拡張機能を読み込む」で `dist/extension` を選びます。
4. Tampermonkey版は無効にしてから、ChatGPTを再読み込みしてください。右下の接続表示を確認します。

Manifest V3のコンテンツスクリプトは `https://chatgpt.com/*` だけで動き、ローカル通信はサービスワーカーが行います。通信先はコード内で `http://127.0.0.1:8766/bridge/` に限定し、拡張機能のメッセージをZodでチェックしています。Chromeのhost permissionはポート番号を限定できないため `http://127.0.0.1/*` を指定していますが、任意URLを受け付ける処理はありません。

変更後は再ビルドし、拡張機能管理画面の「更新」を押してChatGPTを再読み込みしてください。`dist/localgpt-extension-<version>.zip`を展開したフォルダーからも読み込めます。

## Tampermonkeyへの導入

1. ChromeのTampermonkey管理画面で、以前のChatGPT APIスクリプトを無効にします。
2. 新しいスクリプトを作り、`dist/chatgpt-api.user.js` の全内容に置き換えて保存します。`.ts`ファイルは貼り付けません。
3. ログイン済みの `https://chatgpt.com/` を開き、Chatモードを選びます。ページを再読み込みします。
4. 右下の `LocalGPT` が `接続済み · 8875` または `接続済み · HTTP 8766` になれば、ローカルサーバーとの接続ができています。

スクリプトはChatGPTの入力欄へ文章を送信し、回答を読み取って、このMacのローカルAPIへ返します。送信される文章は通常のChatGPT利用と同様にChatGPT側へ届きます。APIの `model` に観測済みのモデルIDを指定すると、拡張機能がChatGPT画面のモデルを切り替えてから送信します。`reasoning.effort` は `choices` にあるブラウザー用の値を使います。切り替えを確認できなければ送信せずエラーになります。

WebSocketがブラウザーにブロックされた場合は、`GM_xmlhttpRequest` を使ったHTTP通信へ自動で切り替わります。CSPを無効にする拡張機能は不要です。Tampermonkeyの要求先は `127.0.0.1` に限定しています。Chrome/Tampermonkeyがユーザースクリプトやローカル接続の許可を表示した場合は、許可内容を確認して操作してください。

複数タブで同時にスクリプトを有効にしないでください。入力欄の下書きは上書きせず、エラーを返します。

## 動作確認

```sh
curl -s http://localhost:8766/health
curl -N http://localhost:8766/v1/responses \
  -H 'Content-Type: application/json' \
  --data '{"input":"接続テストです。短く挨拶してください。","stream":true}'
```

`GET /v1/responses` は案内ページを表示します。回答を生成するにはPOSTを使います。

未接続は503、処理中は409、時間切れは504、不正な入力は400です。画面の入力欄や送信ボタンが見つからない場合も、原因をAPIへ返します。`stream: true` はSSEに対応します。ブラウザーの画面・モデルによる出力の変化を完全な公式API互換として保証するものではありません。

## Responses APIの対応範囲

`POST /v1/responses` を主な呼び出し先として使います。`input` は文字列、または role と content を持つテキストメッセージ配列です。content は文字列または `input_text` の配列を受け付けます。`instructions` は画面へ送るテキストの先頭に developer 指示として付けます。画面操作のため、公式APIのロール分離と同じ強制力はありません。

非ストリームの返答は `object: "response"` と `output[0].content[0].text` を持ちます。`stream: true` は `response.created`、`response.in_progress`、`response.output_item.added`、`response.content_part.added`、`response.output_text.delta`、`response.output_text.done`、`response.content_part.done`、`response.output_item.done`、`response.completed` をSSEで送信します。ストリーム開始後の失敗は `response.failed` で終了し、完成扱いにしません。画面の差分を配信するため、公式APIのトークン単位の配信とは異なります。表示済みの文章が途中で書き換わる場合は `answer_rewritten` で終了します。

テキスト用途の一部互換です。保存・取得API、`previous_response_id`、tools、画像・音声入力、JSON Schema出力、温度・トークン数指定は未対応で、指定すると400を返します。`store` は `false` のみ受け付け、usageは取得できないためnullを返します。`model` と `reasoning.effort` は観測済みのモデル選択肢に対して画面の切り替えを行います。既存の `POST /v1/chat/completions` とそのSSEも残しています。

公式のイベント形式: https://developers.openai.com/api/docs/guides/streaming-responses

## 開発

```sh
bun run typecheck
bun run build
bun run watch
bun run test
```

`src/protocol.ts` が共通Zodスキーマ、`src/chatgpt-dom.ts` が画面操作、`src/browser-app.ts` が共通ブラウザー処理、`src/userscript.ts` がTampermonkeyの起動処理、`src/server.ts` がサーバー側、`src/responses.ts` がResponses入力とSSEイベントの変換です。生成物は `dist/` にあります。watchはユーザースクリプトの再ビルドだけを行うので、型チェックとTampermonkeyへの差し替えは別に実行してください。

初回ビルド時に `.bridge-token` を生成し、ブラウザーとのペアリングに使います。このファイルと生成スクリプト内のキーは公開しないでください。キーを変えた場合はビルド、サーバー再起動、Tampermonkeyへの差し替え、または開発用拡張機能の更新を行います。

## ダッシュボード

`http://localhost:8766/` と `GET /v1/responses` はTailwind CSSをローカルビルドしたダッシュボードを表示します。接続状態の自動更新、導入手順、API呼び出し例のコピーを利用できます。

## 検証の範囲

テストではローカルHTTP/WebSocketの実通信、Zodによる不正データ拒否、エラー終了、リクエストの分離、DOM操作、ビルド済みスクリプトのHTTPフォールバックと回答取得を検証します。生成スクリプトの結合テストは模擬ChatGPT画面を使います。実際のログイン済みChatGPT画面での送信・回答取得は別の確認が必要です。

Docker設定はループバックの8766/8875を公開する形にそろえています。この作業ではDockerでの起動は未検証です。

## MCP

MCPもTypeScript + Zodと公式TypeScript SDKで実装し、Bunで起動します。LocalGPTのHTTPサーバーと、拡張機能が有効なログイン済みChatGPTを先に起動してください。

- `localgpt_status`: ローカルサーバーとブラウザーの接続状態を取得します。
- `localgpt_capabilities`: ChatGPTが受け取ったAPI応答から、利用可能なChat用モデルのID・表示名、reasoningの種類、Thinking effortの選択肢、現在のプランを取得します。未観測はnullです。モデルを変更しません。
- `localgpt_models`: モデルメニューを一時的に開いて画面にあるモデル表示名を取得します。元々閉じていたメニューは閉じ直し、モデルを選び直しません。`selected`は選択されたモデルの表示名、`selectionLabel`はProなどのモード表示です。内部モデルIDやアカウントの全利用可能モデルを保証する一覧ではありません。
- `localgpt_respond`: `input`、任意の`instructions`と`newChat`を受け取り、ChatGPT画面から完成した回答を返します。テキストはChatGPTへ送られます。Workモードでは処理せず、Chatモードへの切り替えを求めるエラーを返します。

ローカルMCPクライアント用stdioは `bun run mcp` で起動します。stdoutはMCPのJSON-RPC専用です。ビルド時に生成する `dist/mcp-config.json` に、このMacのBunとスクリプトの絶対パスを使った設定例があります。クライアントの既存設定へ `mcpServers.localgpt` を追加してください。LocalGPTのHTTPサーバーは別プロセスで `bun run start` します。

Streamable HTTP対応クライアントでは `http://127.0.0.1:8766/mcp` を指定できます。ローカル用・ステートレスです。外部Originや想定外Hostのリクエストは403を返します。MCPはこのMacから接続して使い、インターネットへ公開しません。

MCPの回答ツールは完成した回答を1回のtool resultで返します。文章の増分を受け取る用途は `POST /v1/responses` のSSEを使ってください。RESTからも `GET /v1/models` で同じ画面上のモデル表示名を取得できます。

ブラウザー側も変更しているため、追加後は拡張機能の更新とChatGPTページの再読み込みが必要です。

## モデル・リーゾニング・プランの表示

バージョン2.4の拡張機能/Tampermonkeyを更新し、ChatGPTを再読み込みしてください。ダッシュボードの「モデル一覧」に一覧とプランが表示されます。「情報を更新」は、接続しているブラウザーで観測済みのデータを読み直します。ChatGPTへの追加APIリクエストやモデル選択は行いません。

`GET /v1/capabilities` またはMCPの `localgpt_capabilities` からも取得できます。`src/page-observer.ts` がページ起動時のfetch応答のうち `/backend-api/models`、`/backend-api/accounts/check/v4-2023-04-27`、dots一覧の `/backend-api/tbo`を観測し、共通Zodスキーマで表示に必要なデータへ変換します。氏名、メール、アカウントID、認証情報、請求明細は転送しません。モデルの一覧はenabledなバージョンでpreset_typeがavailableのChat用モデルに絞り、Work用モデルは除外します。Thinking effortはモデルの応答にある選択肢で、公式APIのreasoning.effort値とは別です。`choices` は実際の画面で選択できるモデルとeffortの組合せです。公式APIと同じeffort名とは限りません。

内部APIのため、応答形式が変わると未取得になります。ページを再読み込みするまでに受信済みだった応答は拾えません。情報はページのメモリーだけに保持し、ファイルへ保存しません。


## 話題ごとのセッション

`POST /v1/sessions` で話題ごとのIDを作り、`POST /v1/responses` に `session_id` を渡します。初回は新しいChatGPTチャットを作り、完了時に会話IDを保存します。同じセッションへの次の要求は、そのチャットに移動して続きを送信します。別のセッションと交互に使えます。セッション指定時は `newChat` よりセッションの保存済み会話が優先されます。

```sh
curl http://127.0.0.1:8766/v1/sessions -H 'Content-Type: application/json' \
  -d '{"title":"設計の相談"}'
# 返されたidをsession_idへ指定する
curl http://127.0.0.1:8766/v1/responses -H 'Content-Type: application/json' \
  -d '{"session_id":"作成したUUID","input":"この話題の続きを話そう","stream":true}'
```

`GET /v1/sessions` で一覧を取得できます。作成時に `model`、`reasoning` を指定するとそのセッションの既定になります。個別の要求でも上書きできます。MCPには `localgpt_sessions`、`localgpt_session_create` があり、`localgpt_respond` に同じ `session_id` を渡せます。これはLocalGPTの会話セッションで、MCP接続自体のセッションとは別です。

タイトル・会話ID・モデル・effort・日時は `.localgpt-sessions.sqlite` に保存し、再起動後も使えます。本文はローカルDBに保存せず、会話履歴はChatGPT側で保持します。同じChatGPTアカウントを使ってください。削除済みの会話を自動で別会話へ差し替えません。ChatGPTを複数タブで開くと、異なるsession_idは空いているタブへ割り当てて並列に処理できます。同じsession_idへの同時要求は409です。タブがすべて処理中の場合も409を返します。session_idなしの要求は並列にしません。手動の下書きや生成中の回答があれば移動・送信を止めます。処理中に別会話へ移動した場合も `conversation_changed` で止めます。セッション一覧は最大1000件です。

## dotsの一覧・切り替え・メッセージ

`GET /v1/dots` でChatGPTが受け取ったdots一覧を取得します。複数のdotに対応し、観測できたdotのIDだけを指定できます。ページングのcursorは報告しますが、未観測ページを追加取得する処理はありません。

`POST /v1/dots/select` に `{"dotId":"観測したID"}` を渡して切り替えます。`navigation_requested` の場合はページ移動後の再接続を待ってください。`POST /v1/dots/messages` に `{"dotId":"観測したID","text":"メッセージ"}` を渡すと送信し、送信済みmessageIdを返します。回答取得は `GET /v1/dots/messages?dotId=ID&afterMessageId=送信済みID` を使います。読み取るのは画面に描画されたメッセージだけです。`complete:false` は、dotの作業全体や返答の完了を保証しないことを示します。タイムアウトしても送信済みの場合があるので自動再送しないでください。

MCPの `localgpt_dots`、`localgpt_dot_select`、`localgpt_dot_send`、`localgpt_dot_messages` でも同じ操作ができます。通常のChatの `session_id` とdotのIDは別です。

拡張機能のZIPは `localgpt-extension-<version>.zip` として生成・ダウンロードされます。バージョンはマニフェストと一致します。


## ファイルとLocalMCP

`localgpt_respond` または `POST /v1/responses` の `files` に `[{"path":"/absolute/path/to/source.ts"}]` を指定できます。`mode` は `auto`（既定）・`text`・`upload` です。autoではUTF-8のソースコード・ログ・テキストが256 KiB以下なら本文へ組み込み、画像・PDF・大きいファイルはChatGPTの添付欄へ送ります。PNG/JPEG/WebP/GIFとPDFに対応し、最大10ファイル、各8 MiB、合計16 MiBです。textは各256 KiBまでです。ChatGPT側の添付制限やアップロード失敗はAPIのエラーになります。

LocalMCPの読み書きツールと組み合わせる場合、テキストの読み書きはLocalMCPで行い、読み取った本文をLocalGPTのinputへ渡す使い方でも構いません。LocalGPT自身はファイルを編集しません。画像などの添付とモデルへの送信はChromeの拡張機能が担当します。渡すファイルはChatGPTへ送られるので、利用するAIは利用者が指定・許可したファイルだけを扱ってください。

MCP接続のinitialize応答には、セッション・モデル選択・並列実行・dots・ファイルの利用手順をinstructionsとして渡します。各ツールにも引数と使い方の説明が含まれます。クライアントがinstructionsを読み込むかどうかはクライアントの実装によります。
