// 使用量追跡と Discord Webhook 通知

export interface UsageStats {
  date: string;
  dailyTokens: number;
  dailyCalls: number;
  totalTokens: number;
  totalCalls: number;
  dailyTokenLimit: number;
}

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

async function sendDiscordNotification(
  webhookUrl: string,
  title: string,
  description: string,
  fields: DiscordEmbedField[],
  color: number
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title,
            description,
            fields,
            color,
            timestamp: new Date().toISOString(),
            footer: { text: "cloudflare-markdown-mcp-server" },
          },
        ],
      }),
    });
  } catch {
    // 通知の失敗は変換結果に影響させない
  }
}

export async function recordUsage(
  kv: KVNamespace,
  tokens: number,
  webhookUrl: string | undefined,
  dailyTokenLimit: number
): Promise<void> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dailyTokenKey = `usage:daily:${date}:tokens`;
  const dailyCallKey = `usage:daily:${date}:calls`;
  const totalTokenKey = "usage:total:tokens";
  const totalCallKey = "usage:total:calls";

  const [dailyTokensStr, dailyCallsStr, totalTokensStr, totalCallsStr] =
    await Promise.all([
      kv.get(dailyTokenKey),
      kv.get(dailyCallKey),
      kv.get(totalTokenKey),
      kv.get(totalCallKey),
    ]);

  const prevDailyTokens = parseInt(dailyTokensStr ?? "0") || 0;
  const dailyTokens = prevDailyTokens + tokens;
  const dailyCalls = (parseInt(dailyCallsStr ?? "0") || 0) + 1;
  const totalTokens = (parseInt(totalTokensStr ?? "0") || 0) + tokens;
  const totalCalls = (parseInt(totalCallsStr ?? "0") || 0) + 1;

  // 日次キーは30日で自動削除
  await Promise.all([
    kv.put(dailyTokenKey, String(dailyTokens), {
      expirationTtl: 60 * 60 * 24 * 30,
    }),
    kv.put(dailyCallKey, String(dailyCalls), {
      expirationTtl: 60 * 60 * 24 * 30,
    }),
    kv.put(totalTokenKey, String(totalTokens)),
    kv.put(totalCallKey, String(totalCalls)),
  ]);

  // 上限到達時のみ通知（毎リクエストではなく、閾値をまたいだ瞬間だけ）
  if (
    webhookUrl &&
    dailyTokenLimit > 0 &&
    prevDailyTokens < dailyTokenLimit &&
    dailyTokens >= dailyTokenLimit
  ) {
    await sendDiscordNotification(
      webhookUrl,
      "⚠️ Cloudflare Markdown MCP: 日次使用量上限に達しました",
      `本日（${date}）のトークン使用量が設定した上限を超えました。`,
      [
        { name: "📅 日付", value: date, inline: true },
        {
          name: "🔢 本日のトークン数",
          value: dailyTokens.toLocaleString(),
          inline: true,
        },
        {
          name: "🚦 上限",
          value: dailyTokenLimit.toLocaleString(),
          inline: true,
        },
        {
          name: "📞 本日の呼び出し回数",
          value: String(dailyCalls),
          inline: true,
        },
        {
          name: "📊 累計トークン数",
          value: totalTokens.toLocaleString(),
          inline: true,
        },
        {
          name: "📈 累計呼び出し回数",
          value: String(totalCalls),
          inline: true,
        },
      ],
      0xff4444
    );
  }
}

export async function getUsageStats(
  kv: KVNamespace,
  dailyTokenLimit: number
): Promise<UsageStats> {
  const date = new Date().toISOString().slice(0, 10);
  const [dailyTokensStr, dailyCallsStr, totalTokensStr, totalCallsStr] =
    await Promise.all([
      kv.get(`usage:daily:${date}:tokens`),
      kv.get(`usage:daily:${date}:calls`),
      kv.get("usage:total:tokens"),
      kv.get("usage:total:calls"),
    ]);

  return {
    date,
    dailyTokens: parseInt(dailyTokensStr ?? "0") || 0,
    dailyCalls: parseInt(dailyCallsStr ?? "0") || 0,
    totalTokens: parseInt(totalTokensStr ?? "0") || 0,
    totalCalls: parseInt(totalCallsStr ?? "0") || 0,
    dailyTokenLimit,
  };
}
