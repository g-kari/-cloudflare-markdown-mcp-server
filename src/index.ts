import { MarkdownMCP } from "./mcp";
import { handleApi } from "./api";
import { authenticate } from "./auth";
import type { Env } from "./mcp";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight は認証前に処理
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // ベアラートークン認証（API_SECRET が設定されている場合）
    // ヘルスチェック（/）は認証対象外
    if (url.pathname !== "/") {
      const authError = authenticate(request, env.API_SECRET);
      if (authError) return authError;
    }

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
            auth: env.API_SECRET ? "Bearer token required" : "none",
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
