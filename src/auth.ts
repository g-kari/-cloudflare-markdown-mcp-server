// ベアラートークン認証
// API_SECRET が設定されている場合のみ認証を要求する。
// 未設定の場合はすべてのリクエストを許可する（後方互換）。

export function authenticate(request: Request, apiSecret: string | undefined): Response | null {
  // API_SECRET 未設定なら認証スキップ
  if (!apiSecret) return null;

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (token !== apiSecret) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="cloudflare-markdown-mcp-server"',
        },
      }
    );
  }

  return null;
}
