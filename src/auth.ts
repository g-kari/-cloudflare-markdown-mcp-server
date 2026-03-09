// ベアラートークン認証
// API_SECRET が設定されている場合のみ認証を要求する。
// 未設定の場合はすべてのリクエストを許可する（後方互換）。

// Web Crypto API を使った定数時間比較（タイミング攻撃対策）
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // ランダムな HMAC キーで両者をハッシュ化し、固定長の値を比較する
  // → 文字列長・内容によらず処理時間が一定になる
  const key = (await crypto.subtle.generateKey(
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )) as CryptoKey;
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const aBytes = new Uint8Array(aHash);
  const bBytes = new Uint8Array(bHash);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export async function authenticate(
  request: Request,
  apiSecret: string | undefined
): Promise<Response | null> {
  // API_SECRET 未設定なら認証スキップ
  if (!apiSecret) return null;

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  const valid = await timingSafeEqual(token, apiSecret);
  if (!valid) {
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
