# cloudflare-markdown-mcp-server

Cloudflare AI の [Markdown変換API](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/) を、Claude Code・Codex などの AI エージェントから MCP (Model Context Protocol) 経由で利用できるサーバーです。

Cloudflare Workers 上で動作します。

## MCP Endpoint

```
https://cloudflare-markdown-mcp-server.0g0.xyz/mcp
```

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

`API_SECRET` を設定すると `/mcp` と `/api/*` に Bearer トークン認証が有効になります。未設定の場合は認証なし。

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
  -- npx mcp-remote https://cloudflare-markdown-mcp-server.0g0.xyz/mcp
```

認証あり：
```bash
claude mcp add cloudflare-markdown \
  -- npx mcp-remote https://cloudflare-markdown-mcp-server.0g0.xyz/mcp \
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
      "https://cloudflare-markdown-mcp-server.0g0.xyz/mcp",
      "--header",
      "Authorization: Bearer <your_token>"
    ]
  }
}
```

### ローカルサーバーに接続する場合

```bash
claude mcp add cloudflare-markdown \
  -- npx mcp-remote http://localhost:8788/mcp \
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
