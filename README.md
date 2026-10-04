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

`POST /v1/sessions`で話題ごとのセッションを作り、返されたIDを`session_id`に指定して会話を続けます。異なるセッションは、別々の接続済みChatGPTタブで並列に処理できます。モデルとreasoningは、観測された利用可能な選択肢から指定します。手動の下書きや添付があるタブには送信しません。

Responses APIはテキスト中心の対応範囲です。SSEはブラウザーで観測した回答の増分を返します。ChatGPTのUI変更や接続切断で失敗する場合があり、タイムアウトした送信は自動で再送しません。

詳しい機能・制限は[ローカル利用ガイド](README.local.md)、共有フォルダー・移行・起動方法は[サイドカー利用ガイド](README.sidecar.md)を参照してください。

## 開発

[qtmleap/devcontainers](https://github.com/qtmleap/devcontainers)の`hono-node`例とルート共通設定を土台に、LocalGPT向けに構成しました。アプリケーションの既存Express実装を維持し、プロジェクトの実行・ビルド・テストにはBunを使います。

```sh
bun run check
bun run typecheck
bun run test
```

VS Codeでは「Reopen in Container」で編集・テスト環境を起動できます。Dev Containerと本番サービスのComposeは別です。ホストChromeへ接続するサービスはホストからルートの`compose.yaml`で`docker compose up -d`を実行してください。Dev Container内のlocalhostはホストのlocalhostとは異なります。

テンプレートのDev Containerはホストの設定ディレクトリをマウントします。初回起動前に、存在しないディレクトリを作成してください。

```sh
mkdir -p ~/.aws ~/.claude ~/.codex ~/.ssh ~/.config/gh
```

テンプレートのエディター設定をマージし、Conventional CommitsとBunのCIを採用しています。Biomeはフォーマットに使用します。既存実装を移植するため、テンプレートの独自Gritルールは適用せず、`biome-plugins`サブモジュールは使用していません。Codexの共有設定はローカルの`.codex/`へ置き、Git管理対象にはしません。

## 由来とライセンス

[zsodur/chatgpt-api-by-browser-script](https://github.com/zsodur/chatgpt-api-by-browser-script)を出発点に、TypeScript、Bun、Responses、MCP、拡張機能、セッション管理を追加した派生実装です。アプリケーションのライセンスはISCです。テンプレート由来の設定については[第三者ライセンス表示](THIRD_PARTY_NOTICES.md)を参照してください。
