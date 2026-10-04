import { McpAgent } from "agents/mcp";
import type { Connection, ConnectionContext } from "agents";
import type { MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { LegacySessionRetention, SESSION_RETENTION_KEY, CLEANUP_CALLBACK } from "./session-retention";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  convertFileToMarkdown,
  convertUrlToMarkdown,
  listSupportedFormats,
  getMimeType,
  isImageConversionEnabled,
} from "./converter";
import { recordUsage } from "./usage";

export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace;
  USAGE_KV?: KVNamespace;
  // 画像変換はWorkers AIモデルを使用するため費用が発生する可能性がある。
  // "true" を設定した場合のみ有効化される。デフォルトは無効。
  ENABLE_IMAGE_CONVERSION?: string;
  // ベアラートークン認証。設定した場合、全エンドポイントで認証を要求する。
  // 未設定の場合は認証なし（後方互換）。
  API_SECRET?: string;
  // Discord Webhook URL（使用量通知用）
  DISCORD_WEBHOOK_URL?: string;
  // 日次トークン上限（超えたら Discord に通知）。デフォルト: 100000
  DAILY_TOKEN_LIMIT?: string;
  // 明示的に有効化した場合のみ、24時間無接続の旧SSEセッションを削除する。
  // 既存セッションの一括削除は行わない。
  MCP_SESSION_CLEANUP?: string;
}

// レスポンスヘルパー
const text = (t: string) => ({ type: "text" as const, text: t });
const ok = (t: string) => ({ content: [text(t)] });
const err = (t: string) => ({ content: [text(t)], isError: true });

// 同じツールを、旧SSEと永続DBを持たないHTTPの両方から利用する。
export function createMarkdownServer(env: Env, ctx: Pick<ExecutionContext, "waitUntil">): McpServer {
  const server = new McpServer({ name: "cloudflare-markdown-mcp", version: "1.0.0" });
  registerMarkdownTools(server, env, ctx);
  return server;
}

function registerMarkdownTools(server: McpServer, env: Env, ctx: Pick<ExecutionContext, "waitUntil">): void {
    // ツール1: ファイルをMarkdownに変換
    server.tool(
      "convert_file_to_markdown",
      "ファイル（PDF、Word、Excel、HTML等）をMarkdown形式に変換します。contentにURLを渡した場合（http://またはhttps://で始まる）は自動的にURLのページをMarkdownに変換します。ファイルの場合はBase64エンコードして渡してください。画像変換（JPEG/PNG/WebP/SVG）はサーバー側で ENABLE_IMAGE_CONVERSION=true が設定されている場合のみ利用できます。",
      {
        filename: z
          .string()
          .describe("拡張子付きのファイル名（例: document.pdf, spreadsheet.xlsx）"),
        content: z
          .string()
          .describe("Base64エンコードされたファイルの内容"),
        mimeType: z
          .string()
          .optional()
          .describe("ファイルのMIMEタイプ（省略時はファイル名から自動判定）"),
        conversionOptions: z
          .object({
            descriptionLanguage: z
              .enum(["en", "it", "de", "es", "fr", "pt"])
              .optional()
              .describe("画像変換時のAI説明文の言語（デフォルト: en）"),
            hostname: z
              .string()
              .optional()
              .describe("HTML変換時の相対リンク解決に使うホスト名"),
            cssSelector: z
              .string()
              .optional()
              .describe("HTML変換時に特定要素を抽出するCSSセレクタ（例: main, article, .content）"),
            metadata: z
              .boolean()
              .optional()
              .describe("PDF変換時にメタデータを含めるか（デフォルト: true）"),
          })
          .optional()
          .describe("変換オプション（省略可）"),
      },
      async ({ filename, content, mimeType, conversionOptions }) => {
        // contentがURLの場合はURL変換に自動切り替え
        if (/^https?:\/\//i.test(content.trim())) {
          try {
            const result = await convertUrlToMarkdown(
              env.CLOUDFLARE_ACCOUNT_ID,
              env.CLOUDFLARE_API_TOKEN,
              content.trim(),
              conversionOptions?.cssSelector,
              conversionOptions?.hostname
            );

            if (!result.ok) return err(result.error);

            const dailyLimit = parseInt(env.DAILY_TOKEN_LIMIT ?? "100000") || 100000;
            ctx.waitUntil(recordUsage(env.USAGE_KV, result.tokens, env.DISCORD_WEBHOOK_URL, dailyLimit));

            return ok(`${result.markdown}\n\n---\n*変換元URL: ${content.trim()}*`);
          } catch (error) {
            return err(`エラー: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        let binaryContent: Uint8Array;
        try {
          binaryContent = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
        } catch {
          return err("エラー: contentがBase64エンコードされた文字列ではありません。");
        }

        const resolvedMimeType = mimeType || getMimeType(filename);

        try {
          const result = await convertFileToMarkdown(
            env.CLOUDFLARE_ACCOUNT_ID,
            env.CLOUDFLARE_API_TOKEN,
            isImageConversionEnabled(env.ENABLE_IMAGE_CONVERSION),
            filename,
            binaryContent,
            resolvedMimeType,
            conversionOptions
          );

          if (!result.ok) return err(result.error);

          const dailyLimit = parseInt(env.DAILY_TOKEN_LIMIT ?? "100000") || 100000;
          ctx.waitUntil(recordUsage(env.USAGE_KV, result.tokens, env.DISCORD_WEBHOOK_URL, dailyLimit));

          return ok(
            `${result.markdown}\n\n---\n*変換完了: ${filename} | トークン数: ${result.tokens}*`
          );
        } catch (error) {
          return err(`予期しないエラー: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    // ツール2: URLのコンテンツをMarkdownに変換
    server.tool(
      "convert_url_to_markdown",
      "URLのページコンテンツを取得し、Markdown形式に変換します。HTMLページの内容を構造化したMarkdownとして取得するのに便利です。",
      {
        url: z.string().url().describe("変換するWebページのURL"),
        cssSelector: z
          .string()
          .optional()
          .describe("特定要素を抽出するCSSセレクタ（例: 'main', 'article', '.content'）"),
        hostname: z
          .string()
          .optional()
          .describe("相対リンク解決に使うホスト名（省略時はURLのホスト名を使用）"),
      },
      async ({ url, cssSelector, hostname }) => {
        try {
          const result = await convertUrlToMarkdown(
            env.CLOUDFLARE_ACCOUNT_ID,
            env.CLOUDFLARE_API_TOKEN,
            url,
            cssSelector,
            hostname
          );

          if (!result.ok) return err(result.error);

          const dailyLimit = parseInt(env.DAILY_TOKEN_LIMIT ?? "100000") || 100000;
          ctx.waitUntil(recordUsage(env.USAGE_KV, result.tokens, env.DISCORD_WEBHOOK_URL, dailyLimit));

          return ok(`${result.markdown}\n\n---\n*変換元URL: ${url}*`);
        } catch (error) {
          return err(`エラー: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    // ツール3: 対応フォーマット一覧を取得
    server.tool(
      "list_supported_formats",
      "Markdown変換がサポートするファイル形式の一覧を取得します。",
      {},
      async () => {
        try {
          const result = await listSupportedFormats(
            env.CLOUDFLARE_ACCOUNT_ID,
            env.CLOUDFLARE_API_TOKEN
          );

          if (!result.ok) return err(result.error);

          return ok(JSON.stringify(result.data, null, 2));
        } catch (error) {
          return err(`エラー: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

}

export class MarkdownMCPv2 extends McpAgent<Env> {
  server = new McpServer({ name: "cloudflare-markdown-mcp", version: "1.0.0" });

  private readonly retention = new LegacySessionRetention({
    enabled: () => this.env.MCP_SESSION_CLEANUP === "true",
    read: () => this.ctx.storage.get(SESSION_RETENTION_KEY),
    write: (record) => this.ctx.storage.put(SESSION_RETENTION_KEY, record),
    hasConnections: () => Array.from(this.getConnections()).length > 0,
    schedules: () => this.getSchedules().filter((task) => task.callback === CLEANUP_CALLBACK),
    schedule: async () => { await this.scheduleEvery(3600, CLEANUP_CALLBACK); },
    cancel: (id) => this.cancelSchedule(id),
    exclusive: (callback) => this.ctx.blockConcurrencyWhile(callback),
    destroy: () => this.destroy(),
  });

  async init(): Promise<void> {
    registerMarkdownTools(this.server, this.env, this.ctx);
  }

  async onStart(props?: Record<string, unknown>): Promise<void> {
    await super.onStart(props);
    // start() never refreshes an existing timestamp on hibernation/restart.
    await this.retention.start(this.getTransportType() === "sse");
  }

  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    await super.onConnect(connection, context);
    if (this.getTransportType() === "sse") await this.retention.touch("connect");
  }

  async onSSEMcpMessage(sessionId: string, body: unknown, extraInfo?: MessageExtraInfo): Promise<Error | null> {
    await this.retention.touch("message");
    return super.onSSEMcpMessage(sessionId, body, extraInfo);
  }

  async onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Close only marks activity. Deletion runs in its own alarm invocation.
    await this.retention.touch("close");
  }

  async cleanupLegacySession(): Promise<void> {
    // Alarm invocations may have no Agent name/onStart after reconstruction.
    await this.retention.cleanup();
  }

}
