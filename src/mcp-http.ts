import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMarkdownServer } from "./mcp";
import type { Env } from "./mcp";

export const MCP_HTTP_PATH = "/mcp-http";
export const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, MCP-Protocol-Version, Mcp-Session-Id",
};

// Fresh server/transport per request. No session generator, event store, or
// Durable Object: conversion content and initialization never enter SQL.
export async function handleMcpHttp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...MCP_CORS_HEADERS, Allow: "POST, OPTIONS" } });
  }
  const server = createMarkdownServer(env, ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(MCP_CORS_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    // JSON mode resolves only when the response is complete. Background usage
    // reporting remains registered independently through ctx.waitUntil().
    await server.close();
  }
}
