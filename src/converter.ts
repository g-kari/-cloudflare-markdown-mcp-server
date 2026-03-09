// Cloudflare AI toMarkdown API の共通呼び出しロジック

export interface ConversionOptions {
  descriptionLanguage?: "en" | "it" | "de" | "es" | "fr" | "pt";
  hostname?: string;
  cssSelector?: string;
  metadata?: boolean;
}

export interface ConversionSuccess {
  ok: true;
  markdown: string;
  tokens: number;
  filename: string;
  mimeType: string;
}

export interface ConversionError {
  ok: false;
  error: string;
}

export type ConversionResult = ConversionSuccess | ConversionError;

interface CloudflareToMarkdownResponse {
  result: Array<{
    name: string;
    mimeType: string;
    tokens: number;
    data?: string;
    error?: string;
  }>;
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: string[];
}

export const MIME_TYPES: Record<string, string> = {
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
export const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/svg+xml",
]);

export function getMimeType(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  return MIME_TYPES[ext] || "application/octet-stream";
}

export function isImageMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType);
}

export async function convertFileToMarkdown(
  accountId: string,
  apiToken: string,
  enableImageConversion: boolean,
  filename: string,
  content: Uint8Array,
  mimeType: string,
  options?: ConversionOptions
): Promise<ConversionResult> {
  if (isImageMimeType(mimeType) && !enableImageConversion) {
    return {
      ok: false,
      error: `画像変換は無効です（${filename}）。画像変換には Workers AI モデルが使用され、費用が発生する可能性があります。有効化するには環境変数 ENABLE_IMAGE_CONVERSION=true を設定してください。`,
    };
  }

  const blob = new Blob([content], { type: mimeType });
  const formData = new FormData();
  formData.append("files", blob, filename);
  if (options && Object.keys(options).length > 0) {
    formData.append("conversionOptions", JSON.stringify(options));
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/tomarkdown`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTPエラー: ${response.status} ${response.statusText}`,
    };
  }

  const result = (await response.json()) as CloudflareToMarkdownResponse;

  if (!result.success) {
    const msg = result.errors.map((e) => `[${e.code}] ${e.message}`).join("\n");
    return { ok: false, error: `Cloudflare APIエラー:\n${msg}` };
  }

  const fileResult = result.result[0];
  if (!fileResult) {
    return { ok: false, error: "APIから結果が返りませんでした。" };
  }
  if (fileResult.error) {
    return { ok: false, error: fileResult.error };
  }

  return {
    ok: true,
    markdown: fileResult.data ?? "",
    tokens: fileResult.tokens,
    filename: fileResult.name,
    mimeType: fileResult.mimeType,
  };
}

export async function convertUrlToMarkdown(
  accountId: string,
  apiToken: string,
  url: string,
  cssSelector?: string,
  hostname?: string
): Promise<ConversionResult> {
  const urlObj = new URL(url);

  const fetchResponse = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; CloudflareMarkdownMCP/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!fetchResponse.ok) {
    return {
      ok: false,
      error: `URLの取得に失敗しました: ${fetchResponse.status} ${fetchResponse.statusText}`,
    };
  }

  const htmlContent = await fetchResponse.text();
  const options: Record<string, unknown> = {
    hostname: hostname || urlObj.hostname,
  };
  if (cssSelector) options.cssSelector = cssSelector;

  const blob = new Blob([htmlContent], { type: "text/html" });
  const formData = new FormData();
  formData.append("files", blob, "page.html");
  formData.append("conversionOptions", JSON.stringify(options));

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/tomarkdown`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: formData,
    }
  );

  if (!response.ok) {
    return {
      ok: false,
      error: `HTTPエラー: ${response.status} ${response.statusText}`,
    };
  }

  const result = (await response.json()) as CloudflareToMarkdownResponse;

  if (!result.success) {
    const msg = result.errors.map((e) => `[${e.code}] ${e.message}`).join("\n");
    return { ok: false, error: `Cloudflare APIエラー:\n${msg}` };
  }

  const fileResult = result.result[0];
  if (!fileResult || fileResult.error) {
    return { ok: false, error: fileResult?.error ?? "不明なエラー" };
  }

  return {
    ok: true,
    markdown: fileResult.data ?? "",
    tokens: fileResult.tokens,
    filename: "page.html",
    mimeType: "text/html",
  };
}

export async function listSupportedFormats(
  accountId: string,
  apiToken: string
): Promise<Response> {
  return fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/tomarkdown/supported`,
    { headers: { Authorization: `Bearer ${apiToken}` } }
  );
}
