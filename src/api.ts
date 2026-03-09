// REST API ハンドラー
import {
  convertFileToMarkdown,
  convertUrlToMarkdown,
  listSupportedFormats,
  getMimeType,
} from "./converter";
import type { ConversionOptions } from "./converter";
import type { Env } from "./mcp";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

export async function handleApi(
  request: Request,
  env: Env
): Promise<Response | null> {
  const url = new URL(request.url);
  const enableImageConversion = env.ENABLE_IMAGE_CONVERSION === "true";

  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // GET /api/formats — 対応フォーマット一覧
  if (request.method === "GET" && url.pathname === "/api/formats") {
    const upstream = await listSupportedFormats(
      env.CLOUDFLARE_ACCOUNT_ID,
      env.CLOUDFLARE_API_TOKEN
    );
    const data = await upstream.json();
    return withCors(json(data, upstream.status));
  }

  // POST /api/convert — ファイルをMarkdownに変換
  if (request.method === "POST" && url.pathname === "/api/convert") {
    const contentType = request.headers.get("Content-Type") ?? "";

    let filename: string;
    let content: Uint8Array;
    let mimeType: string;
    let options: ConversionOptions | undefined;

    if (contentType.includes("multipart/form-data")) {
      // multipart/form-data: fileフィールドにファイルを添付
      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        return withCors(json({ success: false, error: "無効なフォームデータです。" }, 400));
      }

      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return withCors(
          json({ success: false, error: "フォームに 'file' フィールドが必要です。" }, 400)
        );
      }

      const fileBlob = file as File;
      filename = fileBlob.name;
      content = new Uint8Array(await fileBlob.arrayBuffer());
      mimeType = fileBlob.type || getMimeType(fileBlob.name);

      const optionsRaw = formData.get("conversionOptions");
      if (optionsRaw && typeof optionsRaw === "string") {
        try {
          options = JSON.parse(optionsRaw) as ConversionOptions;
        } catch {
          return withCors(json({ success: false, error: "conversionOptions が無効なJSONです。" }, 400));
        }
      }
    } else if (contentType.includes("application/json")) {
      // JSON: { filename, content(base64), mimeType?, conversionOptions? }
      let body: {
        filename?: unknown;
        content?: unknown;
        mimeType?: unknown;
        conversionOptions?: unknown;
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return withCors(json({ success: false, error: "無効なJSONです。" }, 400));
      }

      if (typeof body.filename !== "string" || typeof body.content !== "string") {
        return withCors(
          json({ success: false, error: "'filename' と 'content'（Base64）が必要です。" }, 400)
        );
      }

      filename = body.filename;
      try {
        content = Uint8Array.from(atob(body.content), (c) => c.charCodeAt(0));
      } catch {
        return withCors(
          json({ success: false, error: "'content' が有効なBase64文字列ではありません。" }, 400)
        );
      }
      mimeType =
        typeof body.mimeType === "string"
          ? body.mimeType
          : getMimeType(filename);
      if (body.conversionOptions && typeof body.conversionOptions === "object") {
        options = body.conversionOptions as ConversionOptions;
      }
    } else {
      return withCors(
        json(
          {
            success: false,
            error:
              "Content-Type は multipart/form-data または application/json を使用してください。",
          },
          415
        )
      );
    }

    try {
      const result = await convertFileToMarkdown(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        enableImageConversion,
        filename,
        content,
        mimeType,
        options
      );

      if (!result.ok) {
        return withCors(json({ success: false, error: result.error }, 422));
      }

      return withCors(
        json({
          success: true,
          markdown: result.markdown,
          tokens: result.tokens,
          filename: result.filename,
          mimeType: result.mimeType,
        })
      );
    } catch (e) {
      return withCors(
        json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500)
      );
    }
  }

  // POST /api/convert/url — URLをMarkdownに変換
  if (request.method === "POST" && url.pathname === "/api/convert/url") {
    let body: { url?: unknown; cssSelector?: unknown; hostname?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return withCors(json({ success: false, error: "無効なJSONです。" }, 400));
    }

    if (typeof body.url !== "string") {
      return withCors(json({ success: false, error: "'url' フィールドが必要です。" }, 400));
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url);
      void parsedUrl;
    } catch {
      return withCors(json({ success: false, error: "'url' が有効なURLではありません。" }, 400));
    }

    try {
      const result = await convertUrlToMarkdown(
        env.CLOUDFLARE_ACCOUNT_ID,
        env.CLOUDFLARE_API_TOKEN,
        body.url,
        typeof body.cssSelector === "string" ? body.cssSelector : undefined,
        typeof body.hostname === "string" ? body.hostname : undefined
      );

      if (!result.ok) {
        return withCors(json({ success: false, error: result.error }, 422));
      }

      return withCors(
        json({
          success: true,
          markdown: result.markdown,
          tokens: result.tokens,
          url: body.url,
        })
      );
    } catch (e) {
      return withCors(
        json({ success: false, error: e instanceof Error ? e.message : String(e) }, 500)
      );
    }
  }

  return null; // このパスはREST APIの対象外
}
