import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  MCP_OBJECT: DurableObjectNamespace;
  // 画像変換はWorkers AIモデルを使用するため費用が発生する可能性がある。
  // "true" を設定した場合のみ有効化される。デフォルトは無効。
  ENABLE_IMAGE_CONVERSION?: string;
}

interface ConversionResult {
  name: string;
  mimeType: string;
  tokens: number;
  data?: string;
  error?: string;
}

interface CloudflareToMarkdownResponse {
  result: ConversionResult[];
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
}

// ファイル拡張子からMIMEタイプを取得
const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
  ".et": "application/vnd.ms-excel",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".numbers": "application/x-iwork-numbers-sffnumbers",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

// Workers AIモデルを使用する画像MIMEタイプ（費用が発生する可能性あり）
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType);
}

export class MarkdownMCP extends McpAgent<Env> {
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
          .describe(
            "拡張子付きのファイル名（例: document.pdf, image.jpg, spreadsheet.xlsx）"
          ),
        content: z
          .string()
          .describe("Base64エンコードされたファイルの内容"),
        mimeType: z
          .string()
          .optional()
          .describe(
            "ファイルのMIMEタイプ（省略時はファイル名から自動判定）"
          ),
        conversionOptions: z
          .object({
            descriptionLanguage: z
              .enum(["en", "it", "de", "es", "fr", "pt"])
              .optional()
              .describe(
                "画像変換時のAI説明文の言語（デフォルト: en）"
              ),
            hostname: z
              .string()
              .optional()
              .describe(
                "HTML変換時の相対リンク解決に使うホスト名"
              ),
            cssSelector: z
              .string()
              .optional()
              .describe(
                "HTML変換時に特定要素を抽出するCSSセレクタ（例: main, article, .content）"
              ),
            metadata: z
              .boolean()
              .optional()
              .describe("PDF変換時にメタデータを含めるか（デフォルト: true）"),
          })
          .optional()
          .describe("変換オプション（省略可）"),
      },
      async ({ filename, content, mimeType, conversionOptions }) => {
        try {
          // Base64デコード
          let binaryContent: Uint8Array;
          try {
            binaryContent = Uint8Array.from(atob(content), (c) =>
              c.charCodeAt(0)
            );
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "エラー: contentがBase64エンコードされた文字列ではありません。",
                },
              ],
              isError: true,
            };
          }

          const resolvedMimeType = mimeType || getMimeType(filename);

          // 画像変換は Workers AI モデルを使用するため、明示的に有効化が必要
          if (
            isImageMimeType(resolvedMimeType) &&
            this.env.ENABLE_IMAGE_CONVERSION !== "true"
          ) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `画像変換は無効です（${filename}）。\n画像変換には Workers AI モデルが使用され、費用が発生する可能性があります。\n有効化するには環境変数 ENABLE_IMAGE_CONVERSION=true を設定してください。`,
                },
              ],
              isError: true,
            };
          }

          const blob = new Blob([binaryContent], { type: resolvedMimeType });

          const formData = new FormData();
          formData.append("files", blob, filename);

          if (conversionOptions && Object.keys(conversionOptions).length > 0) {
            formData.append(
              "conversionOptions",
              JSON.stringify(conversionOptions)
            );
          }

          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
              },
              body: formData,
            }
          );

          if (!response.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `HTTPエラー: ${response.status} ${response.statusText}\nCloudflare API Tokenとアカウント設定を確認してください。`,
                },
              ],
              isError: true,
            };
          }

          const result =
            (await response.json()) as CloudflareToMarkdownResponse;

          if (!result.success) {
            const errorMessages = result.errors
              .map((e) => `[${e.code}] ${e.message}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cloudflare APIエラー:\n${errorMessages}`,
                },
              ],
              isError: true,
            };
          }

          const fileResult = result.result[0];
          if (!fileResult) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "エラー: APIから結果が返りませんでした。",
                },
              ],
              isError: true,
            };
          }

          if (fileResult.error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `変換エラー（${filename}）: ${fileResult.error}`,
                },
              ],
              isError: true,
            };
          }

          const markdown = fileResult.data ?? "";
          const tokens = fileResult.tokens;

          return {
            content: [
              {
                type: "text" as const,
                text: `${markdown}\n\n---\n*変換完了: ${filename} | トークン数: ${tokens}*`,
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `予期しないエラー: ${message}`,
              },
            ],
            isError: true,
          };
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
          .describe(
            "特定要素を抽出するCSSセレクタ（例: 'main', 'article', '.content'）"
          ),
        hostname: z
          .string()
          .optional()
          .describe(
            "相対リンク解決に使うホスト名（省略時はURLのホスト名を使用）"
          ),
      },
      async ({ url, cssSelector, hostname }) => {
        try {
          const urlObj = new URL(url);

          // URLからHTMLを取得
          const fetchResponse = await fetch(url, {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (compatible; CloudflareMarkdownMCP/1.0)",
              Accept: "text/html,application/xhtml+xml",
            },
          });

          if (!fetchResponse.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `URLの取得に失敗しました: ${fetchResponse.status} ${fetchResponse.statusText}\nURL: ${url}`,
                },
              ],
              isError: true,
            };
          }

          const htmlContent = await fetchResponse.text();
          const blob = new Blob([htmlContent], { type: "text/html" });

          const conversionOptions: Record<string, unknown> = {
            hostname: hostname || urlObj.hostname,
          };
          if (cssSelector) {
            conversionOptions.cssSelector = cssSelector;
          }

          const formData = new FormData();
          formData.append("files", blob, "page.html");
          formData.append(
            "conversionOptions",
            JSON.stringify(conversionOptions)
          );

          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
              },
              body: formData,
            }
          );

          if (!response.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `HTTPエラー: ${response.status} ${response.statusText}`,
                },
              ],
              isError: true,
            };
          }

          const result =
            (await response.json()) as CloudflareToMarkdownResponse;

          if (!result.success) {
            const errorMessages = result.errors
              .map((e) => `[${e.code}] ${e.message}`)
              .join("\n");
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cloudflare APIエラー:\n${errorMessages}`,
                },
              ],
              isError: true,
            };
          }

          const fileResult = result.result[0];
          if (!fileResult || fileResult.error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `変換エラー: ${fileResult?.error ?? "不明なエラー"}`,
                },
              ],
              isError: true,
            };
          }

          const markdown = fileResult.data ?? "";
          return {
            content: [
              {
                type: "text" as const,
                text: `${markdown}\n\n---\n*変換元URL: ${url}*`,
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `エラー: ${message}`,
              },
            ],
            isError: true,
          };
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
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/tomarkdown/supported`,
            {
              headers: {
                Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
              },
            }
          );

          if (!response.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `HTTPエラー: ${response.status} ${response.statusText}`,
                },
              ],
              isError: true,
            };
          }

          const result = await response.json();
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: "text" as const,
                text: `エラー: ${message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }
}
