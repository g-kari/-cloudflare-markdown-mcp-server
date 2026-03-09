import { MarkdownMCP } from "./mcp";
import type { Env } from "./mcp";

export default {
  fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Response | Promise<Response> {
    const url = new URL(request.url);

    // MCP SSEエンドポイント
    if (url.pathname === "/mcp") {
      return MarkdownMCP.serveSSE("/mcp").fetch(request, env, ctx);
    }

    // ヘルスチェック・情報ページ
    if (url.pathname === "/") {
      return new Response(
        JSON.stringify({
          name: "cloudflare-markdown-mcp-server",
          version: "1.0.0",
          description:
            "Cloudflare AI Markdown変換APIをMCP経由で利用できるサーバー",
          mcp_endpoint: "/mcp",
          tools: [
            "convert_file_to_markdown",
            "convert_url_to_markdown",
            "list_supported_formats",
          ],
        }),
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
