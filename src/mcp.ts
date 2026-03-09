import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  convertFileToMarkdown,
  convertUrlToMarkdown,
  listSupportedFormats,
  getMimeType,
  isImageConversionEnabled,
} from "./converter";

export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace;
  // 画像変換はWorkers AIモデルを使用するため費用が発生する可能性がある。
  // "true" を設定した場合のみ有効化される。デフォルトは無効。
  ENABLE_IMAGE_CONVERSION?: string;
  // ベアラートークン認証。設定した場合、全エンドポイントで認証を要求する。
  // 未設定の場合は認証なし（後方互換）。
  API_SECRET?: string;
}

// レスポンスヘルパー
const text = (t: string) => ({ type: "text" as const, text: t });
const ok = (t: string) => ({ content: [text(t)] });
const err = (t: string) => ({ content: [text(t)], isError: true });

export class MarkdownMCPv2 extends McpAgent<Env> {
  server = new McpServer({
    name: "cloudflare-markdown-mcp",
    version: "1.0.0",
  });

  async init(): Promise<void> {
    // ツール1: ファイルをMarkdownに変換
    this.server.tool(
      "convert_file_to_markdown",
      "ファイル（PDF、Word、Excel、HTML等）をMarkdown形式に変換します。画像変換（JPEG/PNG/WebP/SVG）はサーバー側で ENABLE_IMAGE_CONVERSION=true が設定されている場合のみ利用できます。ファイルの内容をBase64エンコードして渡してください。",
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
        let binaryContent: Uint8Array;
        try {
          binaryContent = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
        } catch {
          return err("エラー: contentがBase64エンコードされた文字列ではありません。");
        }

        const resolvedMimeType = mimeType || getMimeType(filename);

        try {
          const result = await convertFileToMarkdown(
            this.env.CLOUDFLARE_ACCOUNT_ID,
            this.env.CLOUDFLARE_API_TOKEN,
            isImageConversionEnabled(this.env.ENABLE_IMAGE_CONVERSION),
            filename,
            binaryContent,
            resolvedMimeType,
            conversionOptions
          );

          if (!result.ok) return err(result.error);

          return ok(
            `${result.markdown}\n\n---\n*変換完了: ${filename} | トークン数: ${result.tokens}*`
          );
        } catch (error) {
          return err(`予期しないエラー: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    // ツール2: URLのコンテンツをMarkdownに変換
    this.server.tool(
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
            this.env.CLOUDFLARE_ACCOUNT_ID,
            this.env.CLOUDFLARE_API_TOKEN,
            url,
            cssSelector,
            hostname
          );

          if (!result.ok) return err(result.error);

          return ok(`${result.markdown}\n\n---\n*変換元URL: ${url}*`);
        } catch (error) {
          return err(`エラー: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    // ツール3: 対応フォーマット一覧を取得
    this.server.tool(
      "list_supported_formats",
      "Markdown変換がサポートするファイル形式の一覧を取得します。",
      {},
      async () => {
        try {
          const result = await listSupportedFormats(
            this.env.CLOUDFLARE_ACCOUNT_ID,
            this.env.CLOUDFLARE_API_TOKEN
          );

          if (!result.ok) return err(result.error);

          return ok(JSON.stringify(result.data, null, 2));
        } catch (error) {
          return err(`エラー: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );
  }
}
