# LocalGPT

ログイン済みのChatGPTを開いたホストのChromeを、ローカルのResponses APIとMCPから利用するサービスです。Bun + TypeScript + Zodで実装し、ブラウザー側はChrome拡張機能またはTampermonkeyスクリプトへビルドします。

同じマシンのCodex Desktopから使う場合、登録するMCPはLocalGPTの1つで構いません。DockerのLocalMCPサイドカーを組み合わせると、チャット操作とファイル・コマンド操作を同じMCPの入口から利用できます。サービスをインターネットへ公開する必要はありません。質問やファイルの内容をChatGPTへ送った場合は、通常どおりChatGPTへの通信が発生します。

## 構成

- ホスト: ログイン済みChatGPTを開いたChromeとLocalGPT拡張機能。
- LocalGPT: Responses API、SSE、MCP、モデル情報、セッション管理、ブラウザー接続。
- LocalMCP: Rust製Dockerサイドカー。共有作業フォルダーの読み書き・検索・コマンド実行。
- Codex Desktop: LocalGPTのMCPへ接続し、必要な道具を選んで作業を進めます。

## Dockerサイドカーで起動

`compose.yaml`でLocalGPTとLocalMCPの2つのサービスを一緒に起動します。ChromeとCodex Desktopはホスト側で動かします。

Docker Composeを使用します。初回の拡張機能ビルドと接続キーの準備にはBun 1.3.11以降も必要です。

```sh
git clone https://github.com/tkgstrator/local-gpt.git
cd local-gpt
bun install --frozen-lockfile
bun run setup:sidecar
docker compose --env-file .localmcp.env up -d --build
```

`setup:sidecar`は拡張機能をビルドし、ローカル専用の認証情報と共有フォルダー設定を生成します。このコマンドはサーバーを起動しません。続く`docker compose`がLocalMCPを起動し、ヘルスチェックの成功後にLocalGPTを起動します。`bun run start:sidecar`も同じComposeコマンドの短縮形です。

`.bridge-token`、`.localmcp-token`、`.localmcp.env`、セッションDB、ペアリング情報を含むビルド成果物はコミットしません。公開用の共通拡張機能を配布するのではなく、各インストールで生成した拡張機能を使用します。

Chromeの`chrome://extensions/`でデベロッパーモードを有効にし、「パッケージ化されていない拡張機能を読み込む」から`dist/extension`を選びます。ChatGPTを再読み込みし、[ローカルダッシュボード](http://localhost:8766/)でサーバー・ブラウザ・リクエスト・ファイル操作の4つの状態を確認してください。

## Codex Desktopから利用

Streamable HTTP対応クライアントには次を登録します。

```text
http://127.0.0.1:8766/mcp
```

stdioを使うクライアント向けには、セットアップで`dist/mcp-config-fused.json`を生成します。LocalMCPを別途登録する必要はありません。`localgpt_*`がChatGPT操作を、`localmcp_*`がファイル・コマンド操作を担当します。

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

VS Codeでは「Reopen in Container」で編集・テスト環境を起動できます。Dev Containerと本番サービスのComposeは別です。ホストChromeへ接続するサービスはホストから`docker compose --env-file .localmcp.env up -d --build`で起動してください。Dev Container内のlocalhostはホストのlocalhostとは異なります。

テンプレートのDev Containerはホストの設定ディレクトリをマウントします。初回起動前に、存在しないディレクトリを作成してください。

```sh
mkdir -p ~/.aws ~/.claude ~/.codex ~/.ssh ~/.config/gh
```

テンプレートのエディター設定をマージし、Conventional CommitsとBunのCIを採用しています。Biomeはフォーマットに使用します。既存実装を移植するため、テンプレートの独自Gritルールは適用せず、`biome-plugins`サブモジュールは使用していません。Codexの共有設定はローカルの`.codex/`へ置き、Git管理対象にはしません。

## 由来とライセンス

[zsodur/chatgpt-api-by-browser-script](https://github.com/zsodur/chatgpt-api-by-browser-script)を出発点に、TypeScript、Bun、Responses、MCP、拡張機能、セッション管理を追加した派生実装です。アプリケーションのライセンスはISCです。テンプレート由来の設定については[第三者ライセンス表示](THIRD_PARTY_NOTICES.md)を参照してください。
