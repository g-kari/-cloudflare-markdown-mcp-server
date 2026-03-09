import { MarkdownMCP } from "./mcp";
import { handleApi } from "./api";
import type { Env } from "./mcp";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP SSEエンドポイント
    if (url.pathname === "/mcp") {
      return MarkdownMCP.serveSSE("/mcp").fetch(request, env, ctx);
    }

    // REST APIエンドポイント (/api/*)
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApi(request, env);
      if (response) return response;
    }

    // ヘルスチェック・情報ページ
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify(
          {
            name: "cloudflare-markdown-mcp-server",
            version: "1.0.0",
            description:
              "Cloudflare AI Markdown変換APIをMCP経由で利用できるサーバー",
            endpoints: {
              mcp: "/mcp",
              rest: {
                "POST /api/convert":
                  "ファイルをMarkdownに変換 (multipart/form-data または JSON+base64)",
                "POST /api/convert/url": "URLのページをMarkdownに変換",
                "GET /api/formats": "対応フォーマット一覧",
              },
            },
          },
          null,
          2
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

// Durable Object クラスをエクスポート（wrangler.jsonc から参照）
export { MarkdownMCP };
