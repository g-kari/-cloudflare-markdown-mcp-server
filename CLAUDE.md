# CLAUDE.md

このファイルは Claude Code がこのリポジトリで作業する際の指針です。

## プロジェクト概要

Cloudflare AI の `toMarkdown` API を MCP サーバーとして提供する Cloudflare Workers プロジェクト。
Claude Code・Codex などの AI エージェントがファイルや URL を Markdown に変換できるようになる。

## 技術スタック

- **ランタイム**: Cloudflare Workers (Durable Objects 使用)
- **MCP フレームワーク**: `agents/mcp` (McpAgent) + `@modelcontextprotocol/sdk`
- **言語**: TypeScript (strict モード)
- **パッケージ管理**: npm (devbox 経由)
- **デプロイツール**: wrangler v4

## 主要ファイル

| ファイル | 役割 |
|---------|------|
| `src/mcp.ts` | `MarkdownMCP` クラス・MCPツール定義 |
| `src/index.ts` | Worker エントリポイント・`/mcp` ルーティング |
| `wrangler.jsonc` | Workers 設定・Durable Objects・カスタムドメイン |
| `devbox.json` | 開発環境定義 (nodejs@22.22.0) |
| `Makefile` | 開発・デプロイコマンド集約 |

## 開発コマンド

コマンドは必ず `devbox run` 経由で実行する：

```bash
make install      # npm install
make start        # wrangler dev (localhost:8788)
make build        # tsc --noEmit
make deploy       # wrangler deploy
make logs         # wrangler tail
make inspector    # MCP Inspector 起動
```

## エージェントチーム

`.claude/agents/` 配下にサブエージェントが定義されており、役割ごとに参照・起動できる：

- **project-manager** — タスク管理・アーキテクチャ決定
- **mcp-developer** — McpAgent 実装・wrangler 設定
- **api-integrator** — Cloudflare AI REST API 統合
- **tester** — MCP Inspector・エッジケーステスト
- **deployer** — wrangler デプロイ・シークレット設定・接続設定

## Cloudflare AI API

### エンドポイント

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/tomarkdown
GET  https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/tomarkdown/supported
```

### リクエスト形式

`multipart/form-data` で送信：
- `files`: 変換ファイル（複数可）
- `conversionOptions`: JSON 文字列（省略可）

### 環境変数

| 変数名 | 説明 |
|--------|------|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID |
| `CLOUDFLARE_API_TOKEN` | Workers AI 実行権限付き API Token |

ローカル開発: `.dev.vars` に記述
本番環境: `wrangler secret put` で設定

## MCP ツール一覧

| ツール名 | 引数 | 説明 |
|---------|------|------|
| `convert_file_to_markdown` | `filename`, `content`(base64), `mimeType?`, `conversionOptions?` | ファイルを Markdown に変換 |
| `convert_url_to_markdown` | `url`, `cssSelector?`, `hostname?` | URL コンテンツを Markdown に変換 |
| `list_supported_formats` | なし | 対応フォーマット一覧を取得 |

## コード変更時の注意

1. `McpAgent<Env>` を継承・`init()` 内でツール登録
2. 型エラーは必ず修正してからコミット (`make build`)
3. エラー時は `isError: true` を返す
4. Durable Objects の変更時は `wrangler.jsonc` の `migrations` を更新

## デプロイ先

- **本番 URL**: `https://cloudflare-markdown-mcp-server.0g0.xyz`
- **MCP Endpoint**: `https://cloudflare-markdown-mcp-server.0g0.xyz/mcp`
- **Workers URL**: `https://cloudflare-markdown-mcp-server.0g0.workers.dev`
- **GitHub**: `https://github.com/g-kari/-cloudflare-markdown-mcp-server`
