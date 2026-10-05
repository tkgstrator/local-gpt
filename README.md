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

```sh
docker compose logs --tail=100
docker compose stop
# イメージを更新して再起動
docker compose pull
docker compose up -d
```

`docker compose down -v`は接続キーやセッション、共有ファイルも削除します。通常の停止には`stop`を使ってください。ホストのソースコードを共有する場合は、両サービスの`workspace:/workspace`を同じホストフォルダーのbind mount（例: `./workspace:/workspace`）に変更します。

## Codex Desktopから利用

Streamable HTTP対応クライアントには次を登録します。

```text
http://127.0.0.1:8766/mcp
```

Dockerだけでの利用には上記のHTTP接続を使います。ソースから開発する場合は、stdio向けの`dist/mcp-config-fused.json`も生成できます。LocalMCPを別途登録する必要はありません。`localgpt_*`がChatGPT操作を、`localmcp_*`がファイル・コマンド操作を担当します。

Codex DesktopがLocalMCPでファイルを読み、必要な内容をLocalGPTへ送って質問し、返答に基づいて編集する流れを想定しています。ChatGPT自身がLocalMCPを直接呼ぶ接続や、Mac全体のComputer Useは実装していません。

## APIとセッション

```sh
curl -N http://127.0.0.1:8766/v1/responses \
  -H 'Content-Type: application/json' \
  --data '{"input":"こんにちは","stream":true}'
```

`POST /v1/sessions`で話題ごとのセッションを作り、返されたIDを`session_id`に指定して会話を続けます。ブラウザー操作はサービス全体で同時に1件だけ処理します。すべての呼び出しは、サーバーが選んだ既存の共有ChatGPTタブ1つに送られ、他のタブは待機用で、共有タブの接続が切れて処理中の操作がない場合にだけ引き継がれます。処理中に別の操作を送ると`409 browser_busy`で送信前に拒否されます。モデルとreasoningは、観測された利用可能な選択肢から指定します。通常のテキスト下書きは保存・退避してから送信し、新しい手入力は上書きしません。添付や安全に保存できない下書きは保護します。

Responses APIはテキスト中心の対応範囲です。SSEはブラウザーで観測した回答の増分を返します。ChatGPTのUI変更や接続切断で失敗する場合があり、タイムアウトした送信は自動で再送しません。

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

MCPでは`localgpt_response_start`と`localgpt_response_get`（待機は最大25秒、完了すると即座に返る）を使います。`localgpt_respond`はProモデルまたは`background:true`のときジョブ受付を返し、それ以外のモデルは従来どおり本文を直接返します。リモート生成を取り消すツールはありません。

### 永続化

Composeは既存のLocalGPT状態ボリュームに`LOCALGPT_RESPONSE_JOBS_DIR=/var/lib/localgpt/response-jobs`を設定します。ディレクトリは`0700`、ファイルは`0600`で、途中本文と結果を保存し、`instructions`と入力は保存しません。未設定の場合、ジョブはメモリ内だけで再起動で失われます。再起動後に未完了だったジョブは`unresponsive`（結果不明）として復元され、ブラウザー枠を確保し続けます。自動の再開・再送はしません。

保存失敗はジョブの`persistenceError`に表示します。メモリ内の状態・結果は取得でき、保存先が回復すると再保存します。初回保存ができない要求は送信前に拒否します。

### 入力欄の下書き

空の装飾付きProseMirror段落は空欄として扱います。通常のテキスト下書きは、元の会話と本文をこのタブの`sessionStorage`に保存して確認してから入力欄を空にし、完了後に元の会話の空欄へ復元します。新しい手入力は上書きしません。別の会話の下書きは右下の保存一覧から元の会話へ戻して復元、または本文をコピーできます。タブを閉じると保存領域も失われるため、必要な下書きは先に回収してください。リッチテキスト・添付・保存失敗・内容の競合がある場合は下書きを保持して送信を止めます。

### 拡張機能の更新

ネイティブストリームの観測には拡張機能2.4.2が必要です。サービスを更新したら`/extension`から再取得して読み込み直し、ChatGPTを再読み込みしてください（Tampermonkey版も同様）。古い拡張機能では非同期ジョブは結果不明のまま残ります。

### 不明なジョブの手動復旧

サーバーはリモートのキャンセルを行いません。`unresponsive`のまま回復しないジョブは、次の手順で人が復旧します。

1. LocalGPTを停止します（`docker compose stop localgpt`）。
2. ChatGPTを開き、生成中でないこと（待機状態）を目視で確認します。生成中なら停止または完了を待ちます。
3. `localgpt-state`ボリュームの`response-jobs`と`sessions.sqlite`のバックアップを取ります。
4. 該当ジョブの`<id>.json`を削除します。必要な途中本文は先に控えます。
5. LocalGPTを再起動します。

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
