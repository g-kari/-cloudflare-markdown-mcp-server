import { MarkdownMCPv2 } from "./mcp";
import { handleApi } from "./api";
import { authenticate } from "./auth";
import { CORS_HEADERS } from "./api";
import type { Env } from "./mcp";
import { getUsageStats } from "./usage";

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    if (!env.DISCORD_WEBHOOK_URL) return;

    const dailyLimit = parseInt(env.DAILY_TOKEN_LIMIT ?? "100000") || 100000;
    const stats = await getUsageStats(env.USAGE_KV, dailyLimit);
    const usagePercent = dailyLimit > 0
      ? Math.round((stats.dailyTokens / dailyLimit) * 100)
      : 0;
    const color = usagePercent >= 100 ? 0xff4444 : usagePercent >= 80 ? 0xff8800 : 0x00bb77;
    const statusIcon = usagePercent >= 100 ? "🔴" : usagePercent >= 80 ? "🟡" : "🟢";

    await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: `${statusIcon} Cloudflare Markdown MCP: 日次使用量レポート`,
          description: `**${stats.date}** の使用状況サマリーです。`,
          color,
          fields: [
            { name: "📅 日付", value: stats.date, inline: true },
            { name: "🔢 本日のトークン数", value: stats.dailyTokens.toLocaleString(), inline: true },
            { name: "🚦 上限", value: `${dailyLimit.toLocaleString()} (${usagePercent}%)`, inline: true },
            { name: "📞 本日の呼び出し回数", value: String(stats.dailyCalls), inline: true },
            { name: "📊 累計トークン数", value: stats.totalTokens.toLocaleString(), inline: true },
            { name: "📈 累計呼び出し回数", value: String(stats.totalCalls), inline: true },
          ],
          footer: { text: "cloudflare-markdown-mcp-server • 毎日 18:00 JST" },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  },

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
      const response = await handleApi(request, env, ctx);
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
                "GET /api/usage": "使用量統計（日次・累計トークン数・呼び出し回数）",
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
