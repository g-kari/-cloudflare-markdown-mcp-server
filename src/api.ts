// REST API ハンドラー
import {
  convertFileToMarkdown,
  convertUrlToMarkdown,
  listSupportedFormats,
  getMimeType,
  isImageConversionEnabled,
  validateUrl,
  MAX_FILE_SIZE,
} from "./converter";
import type { ConversionOptions } from "./converter";
import type { Env } from "./mcp";

export const CORS_HEADERS: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const enableImages = isImageConversionEnabled(env.ENABLE_IMAGE_CONVERSION);

  // GET /api/formats — 対応フォーマット一覧
  if (request.method === "GET" && url.pathname === "/api/formats") {
    const result = await listSupportedFormats(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN
    );
    if (!result.ok) return json({ success: false, error: result.error }, 502);
    return json(result.data);
  }

  // POST /api/convert — ファイルをMarkdownに変換
  if (request.method === "POST" && url.pathname === "/api/convert") {
    const contentType = request.headers.get("Content-Type") ?? "";

    let filename: string;
    let content: Uint8Array;
    let mimeType: string;
    let options: ConversionOptions | undefined;

    if (contentType.includes("multipart/form-data")) {
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return json({ success: false, error: "無効なフォームデータです。" }, 400);
      }

      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return json({ success: false, error: "フォームに 'file' フィールドが必要です。" }, 400);
      }

      const fileBlob = file as File;
      if (fileBlob.size > MAX_FILE_SIZE) {
        return json(
          { success: false, error: `ファイルサイズが上限（${MAX_FILE_SIZE / 1024 / 1024}MB）を超えています。` },
          413
        );
      }

      filename = fileBlob.name;
      content = new Uint8Array(await fileBlob.arrayBuffer());
      mimeType = fileBlob.type || getMimeType(fileBlob.name);

      const optionsRaw = formData.get("conversionOptions");
      if (optionsRaw && typeof optionsRaw === "string") {
        try {
          options = JSON.parse(optionsRaw) as ConversionOptions;
        } catch {
          return json({ success: false, error: "conversionOptions が無効なJSONです。" }, 400);
        }
      }
    } else if (contentType.includes("application/json")) {
      let body: {
        filename?: unknown;
        content?: unknown;
        mimeType?: unknown;
        conversionOptions?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ success: false, error: "無効なJSONです。" }, 400);
      }

      if (typeof body.filename !== "string" || typeof body.content !== "string") {
        return json(
          { success: false, error: "'filename' と 'content'（Base64）が必要です。" },
          400
        );
      }

      // Base64サイズの簡易チェック（base64は元サイズの約4/3倍）
      if (body.content.length > MAX_FILE_SIZE * 1.4) {
        return json(
          { success: false, error: `ファイルサイズが上限（${MAX_FILE_SIZE / 1024 / 1024}MB）を超えています。` },
          413
        );
      }

      filename = body.filename;
      try {
        content = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
      } catch {
        return json(
          { success: false, error: "'content' が有効なBase64文字列ではありません。" },
          400
        );
      }
      mimeType =
        typeof body.mimeType === "string" ? body.mimeType : getMimeType(filename);
      if (body.conversionOptions && typeof body.conversionOptions === "object") {
        options = body.conversionOptions as ConversionOptions;
      }
    } else {
      return json(
        {
          success: false,
          error: "Content-Type は multipart/form-data または application/json を使用してください。",
        },
        415
      );
    }

    try {
      const result = await convertFileToMarkdown(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        enableImages,
        filename,
        content,
        mimeType,
        options
      );
      if (!result.ok) return json({ success: false, error: result.error }, 422);
      return json({
        success: true,
        markdown: result.markdown,
        tokens: result.tokens,
        filename: result.filename,
        mimeType: result.mimeType,
      });
    } catch (e) {
      console.error("convert error:", e);
      return json({ success: false, error: "内部サーバーエラーが発生しました。" }, 500);
    }
  }

  // POST /api/convert/url — URLをMarkdownに変換
  if (request.method === "POST" && url.pathname === "/api/convert/url") {
    let body: { url?: unknown; cssSelector?: unknown; hostname?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ success: false, error: "無効なJSONです。" }, 400);
    }

    if (typeof body.url !== "string") {
      return json({ success: false, error: "'url' フィールドが必要です。" }, 400);
    }

    const urlError = validateUrl(body.url);
    if (urlError) return json({ success: false, error: urlError }, 400);

    try {
      const result = await convertUrlToMarkdown(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        body.url,
        typeof body.cssSelector === "string" ? body.cssSelector : undefined,
        typeof body.hostname === "string" ? body.hostname : undefined
      );
      if (!result.ok) return json({ success: false, error: result.error }, 422);
      return json({
        success: true,
        markdown: result.markdown,
        tokens: result.tokens,
        url: body.url,
      });
    } catch (e) {
      console.error("convert/url error:", e);
      return json({ success: false, error: "内部サーバーエラーが発生しました。" }, 500);
    }
  }

  return null; // このパスはREST APIの対象外
}
