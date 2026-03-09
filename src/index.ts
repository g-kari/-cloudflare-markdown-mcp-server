import { MarkdownMCPv2 } from "./mcp";
import { handleApi } from "./api";
import { authenticate } from "./auth";
import { CORS_HEADERS } from "./api";
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
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ベアラートークン認証（API_SECRET が設定されている場合）
    // ヘルスチェック（/）は認証対象外
    if (url.pathname !== "/") {
      const authError = await authenticate(request, env.API_SECRET);
      if (authError) return authError;
    }

    // MCPエンドポイント（Streamable HTTP + SSEフォールバック対応）
    if (url.pathname.startsWith("/mcp")) {
      return MarkdownMCPv2.mount("/mcp").fetch(request, env, ctx);
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
            description: "Cloudflare AI Markdown変換APIをMCP経由で利用できるサーバー",
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
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  },
};

export { MarkdownMCPv2 };

// 旧クラスのスタブ（既存DOの参照を保持するために必要）
// v2マイグレーション完了後に削除予定
export class MarkdownMCP implements DurableObject {
  readonly ctx: DurableObjectState;
  readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  async fetch(_request: Request): Promise<Response> {
    return new Response("Deprecated: use MarkdownMCPv2", { status: 410 });
  }
}
