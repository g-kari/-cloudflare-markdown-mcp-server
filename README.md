# cloudflare-markdown-mcp-server

Cloudflare AI の [Markdown変換API](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) を、Claude Code・Codex などの AI エージェントから MCP (Model Context Protocol) 経由で利用できるサーバーです。

Cloudflare Workers 上で動作します。

## ワンクリックデプロイ

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/g-kari/-cloudflare-markdown-mcp-server)

デプロイ後、以下のシークレットを設定してください：

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID  # Cloudflare アカウント ID
npx wrangler secret put CLOUDFLARE_API_TOKEN   # Workers AI 権限付き API トークン
```

> **API Token の作成方法**: [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) → Custom token → `Workers AI: Run` 権限を付与

## MCP Endpoint

```
https://cloudflare-markdown-mcp-server.0g0.xyz/mcp-http
```

## MCP の接続方式と保存量

推奨の `/mcp-http` はステートレス Streamable HTTP です。各 POST ごとに MCP サーバーと transport を生成し、MCP セッション用の Durable Object / SQL データベースを作りません。GET / DELETE は 405 を返します（SDK の接続後 GET プローブも安全です）。ツール、Bearer 認証、変換処理、KV の使用量記録は従来と同じです。

既存の `/mcp` と `/mcp/message` は旧 SSE クライアント用に維持しています。既存クライアントはそのまま利用できますが、SQL 保存量の増加を止めるには接続 URL を `/mcp-http` に変更してください。旧 SSE の GET は接続ごとに Durable Object を作ります。接続終了だけではそのデータベースを自動回収しない SDK バージョンのため、未使用のセッション DB が積み重なることがあります。旧 SDK の bridge WebSocket が切断後も OPEN に残る場合、下記の TTL は回収を安全側で見送ります。推奨 HTTP ルートへの移行を優先してください。

### 旧 SSE の期限切れセッション回収（明示的な有効化が必要）

`MCP_SESSION_CLEANUP=true` を設定した場合だけ、記録済みの旧 SSE セッションを約 1 時間ごとに確認します。切断通知が遅れたり失われた場合は、最初に無接続を観測した時点から新たに 24 時間の猶予を設けます。接続がなく、最後の活動・切断から 24 時間経過したセッションを `Agent.destroy()` で削除します（最大約 1 時間の遅延あり）。デフォルトでは削除しません。

- 削除は当該 Durable Object 内部の SQL / KV storage を完全に消去します。別の `USAGE_KV` namespace は削除しません。運用者が影響を確認してから有効化してください
- 活動中の接続、24 時間未経過のセッション、欠損・不正な保持情報は削除しません
- 再起動・休止復帰で期限を延長せず、接続・メッセージ・切断で期限を更新します
- 古いセッションに年齢情報がない場合、初めて再接続された時点から観測期間を開始します
- この設定は一度も再訪されない既存の DB を一括削除しません。既に蓄積した保存量は、別途対象を確認した回収が必要です
- クラス、namespace、過去の migrations は変更しません。既存セッションを削除する migration はありません

開発時は `make test`（devbox がない環境では `npm test`）で、実際の Wrangler dry-run bundle を Miniflare 上で検証できます。変換 API はテスト内で模擬され、Cloudflare の本番リソースや実際の変換課金にはアクセスしません。

## 提供ツール

| ツール名 | 説明 |
|---------|------|
| `convert_file_to_markdown` | PDF・Word・Excel・HTML・画像などを Markdown に変換 |
| `convert_url_to_markdown` | URL のページコンテンツを Markdown に変換 |
| `list_supported_formats` | 変換対応フォーマット一覧を取得 |

### 対応ファイル形式

| カテゴリ | 拡張子 |
|---------|--------|
| ドキュメント | `.pdf` |
| Web | `.html`, `.htm`, `.xml` |
| データ | `.csv` |
| Word | `.docx` |
| Excel | `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, `.et` |
| OpenDocument | `.odt`, `.ods` |
| Apple | `.numbers` |
| 画像 | `.jpg`, `.jpeg`, `.png`, `.webp`, `.svg` |

## セットアップ

### 必要なもの

- [devbox](https://www.jetify.com/devbox) (`curl -fsSL https://get.jetify.com/devbox | bash`)
- Cloudflare アカウント（[登録](https://dash.cloudflare.com/sign-up)）
- Cloudflare API Token（[作成方法](#api-token-の作成)）

### インストール

```bash
git clone https://github.com/g-kari/-cloudflare-markdown-mcp-server.git
cd cloudflare-markdown-mcp-server
make install
```

### 環境変数の設定

ローカル開発用に `.dev.vars` を作成：

```bash
cp .dev.vars.example .dev.vars
# .dev.vars を編集して CLOUDFLARE_ACCOUNT_ID と CLOUDFLARE_API_TOKEN を設定
```

### ローカル起動

```bash
make start
# http://localhost:8788 で起動
```

## デプロイ

```bash
# Cloudflare にログイン
npx wrangler login

# シークレット設定
make secret-account-id  # CLOUDFLARE_ACCOUNT_ID を入力
make secret-api-token   # CLOUDFLARE_API_TOKEN を入力

# デプロイ
make deploy
```

## 認証（オプション）

`API_SECRET` を設定すると `/mcp-http`、旧 `/mcp` と `/api/*` に Bearer トークン認証が有効になります。未設定の場合は認証なし。

### トークン発行

```bash
# openssl（推奨）
openssl rand -hex 32

# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Python
python3 -c "import secrets; print(secrets.token_hex(32))"
```

### 本番環境に設定

```bash
npx wrangler secret put API_SECRET
# → 上で生成したトークンを入力
```

### ローカル環境に設定

`.dev.vars` に追記：
```
API_SECRET=<生成したトークン>
```

## AI エージェントへの接続

### Claude Code（ワンライナー）

認証なし：
```bash
claude mcp add cloudflare-markdown \
  -- npx mcp-remote https://cloudflare-markdown-mcp-server.0g0.xyz/mcp-http
```

認証あり：
```bash
claude mcp add cloudflare-markdown \
  -- npx mcp-remote https://cloudflare-markdown-mcp-server.0g0.xyz/mcp-http \
  --header "Authorization: Bearer <your_token>"
```

追加後、`/mcp` コマンドで 3 つのツールが表示されます。

削除する場合：
```bash
claude mcp remove cloudflare-markdown
```

最終的に `~/.claude.json` の `mcpServers` は以下のようになります：

```json
{
  "cloudflare-markdown": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "mcp-remote",
      "https://cloudflare-markdown-mcp-server.0g0.xyz/mcp-http",
      "--header",
      "Authorization: Bearer <your_token>"
    ]
  }
}
```

### ローカルサーバーに接続する場合

```bash
claude mcp add cloudflare-markdown \
  -- npx mcp-remote http://localhost:8788/mcp-http \
  --header "Authorization: Bearer <your_token>"
```

## 開発コマンド

```bash
make help             # コマンド一覧表示
make install          # 依存パッケージインストール
make start            # ローカル開発サーバー起動
make build            # TypeScript 型チェック
make deploy           # Cloudflare Workers にデプロイ
make logs             # Worker ログをリアルタイム確認
make inspector        # MCP Inspector でツールをテスト
make secret-list      # 設定済みシークレット一覧
```

## API Token の作成

1. [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) にアクセス
2. "Create Token" → "Custom token" を選択
3. 以下の権限を付与：
   - `Workers AI` — Run
   - `Workers Scripts` — Edit
4. トークンを生成してコピー

## プロジェクト構造

```
cloudflare-markdown-mcp-server/
├── .claude/
│   └── agents/              # Claude Code サブエージェント定義
│       ├── project-manager.md
│       ├── mcp-developer.md
│       ├── api-integrator.md
│       ├── tester.md
│       └── deployer.md
├── src/
│   ├── index.ts             # Worker エントリポイント
│   └── mcp.ts               # MCP ツール実装 (MarkdownMCP クラス)
├── .dev.vars.example        # 環境変数テンプレート
├── devbox.json              # 開発環境定義
├── Makefile                 # コマンド集約
├── wrangler.jsonc           # Cloudflare Workers 設定
├── package.json
└── tsconfig.json
```

## ライセンス

MIT
