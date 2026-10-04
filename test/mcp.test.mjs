import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Miniflare } from "miniflare";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Bundle through Wrangler's real production compatibility/polyfill pipeline.
// --dry-run never uploads code or calls a billable conversion service.
const dir = mkdtempSync(resolve(".test-build-"));
const bundle = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--dry-run", "--env", "production", "--outdir", join(dir, "worker")], {
  encoding: "utf8",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(dir, "logs"), XDG_CONFIG_HOME: join(dir, "config") },
});
assert.equal(bundle.status, 0, bundle.stderr + bundle.stdout);

// Test-only RPCs inspect metadata/counts, never production state or secrets.
writeFileSync(join(dir, "fixture.mjs"), `
import worker, { MarkdownMCPv2 as Base, MarkdownMCP } from "./worker/index.js";
export { MarkdownMCP };
export class MarkdownMCPv2 extends Base {
  getTransportType() {
    if (this.coldAlarmTest) throw new Error("cold alarm must not read an Agent name");
    return super.getTransportType();
  }
  async inspect() {
    return { connections: Array.from(this.getConnections()).length,
      retention: await this.ctx.storage.get("markdown:mcp:legacy-retention:v1"),
      schedules: this.getSchedules().filter(s => s.callback === "cleanupLegacySession").length };
  }
  async setRetention(lastActivityAt) { await this.ctx.storage.put("markdown:mcp:legacy-retention:v1", {version:1,transport:"sse",lastActivityAt,disconnectedAt:lastActivityAt}); }
  async seedColdAlarm() {
    this.coldAlarmTest = true;
    await this.setRetention(Date.now() - 25 * 60 * 60 * 1000);
    await this.scheduleEvery(3600, "cleanupLegacySession");
    this.ctx.storage.sql.exec("UPDATE cf_agents_schedules SET time = ? WHERE callback = ?", Math.floor(Date.now()/1000)-1, "cleanupLegacySession");
  }
  async simulateAlarm() {
    await this.alarm();
    return this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'cf_agents_%'").one().count;
  }
}
export default worker;
`);

const outbound = [];
const mf = new Miniflare({
  modules: true, scriptPath: join(dir, "fixture.mjs"), compatibilityDate: "2024-12-01", compatibilityFlags: ["nodejs_compat"],
  modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
  durableObjects: { MCP_OBJECT: { className: "MarkdownMCPv2", useSQLite: true } },
  durableObjectsPersist: join(dir, "do"), kvNamespaces: ["USAGE_KV"],
  bindings: { CLOUDFLARE_ACCOUNT_ID: "test-account", CLOUDFLARE_API_TOKEN: "test-token", API_SECRET: "test-secret", MCP_SESSION_CLEANUP: "true" },
  outboundService: async (request) => {
    outbound.push(new URL(request.url).pathname);
    if (request.url === "https://source.example/page") return new Response("<main>test page</main>");
    if (request.url.endsWith("/supported")) return Response.json({ success: true, result: ["text/html"] });
    if (request.url.endsWith("/ai/tomarkdown")) return Response.json({ success: true, result: [{ name: "test.html", mimeType: "text/html", tokens: 7, data: "# Test markdown" }], errors: [], messages: [] });
    throw new Error("Unexpected outbound request: " + request.url);
  },
});
after(async () => { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); });

const auth = { Authorization: "Bearer test-secret" };
const headers = { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
function post(body, extra = {}) {
  return mf.dispatchFetch("https://worker.test/mcp-http", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
}
function databases(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? databases(join(path, entry.name)) : entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite" ? [join(path, entry.name)] : []);
}

test("official Streamable HTTP client works without creating a Durable Object", async () => {
  const requests = [];
  const transport = new StreamableHTTPClientTransport(new URL("https://worker.test/mcp-http"), {
    requestInit: { headers: auth },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request.method);
      // Miniflare's Undici Request differs from Node's built-in Request.
      return mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
    },
  });
  const client = new Client({ name: "test-client", version: "1" });
  try {
    await client.connect(transport);
    assert.equal(transport.sessionId, undefined);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["convert_file_to_markdown", "convert_url_to_markdown", "list_supported_formats"]);
    const result = await client.callTool({ name: "convert_file_to_markdown", arguments: { filename: "test.pdf", content: "invalid!!" } });
    assert.equal(result.isError, true);
    assert.ok(requests.includes("GET"), "SDK must exercise the no-DO standalone GET probe");
    assert.equal(databases(join(dir, "do")).length, 0);
  } finally { await client.close(); }
});

test("HTTP preflight/auth/errors/GET/DELETE preserve correct status and CORS", async () => {
  const preflight = await mf.dispatchFetch("https://worker.test/mcp-http", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  for (const header of ["accept", "mcp-protocol-version", "mcp-session-id", "authorization"]) assert.ok(preflight.headers.get("access-control-allow-headers").toLowerCase().includes(header));
  const unauthorized = await mf.dispatchFetch("https://worker.test/mcp-http", { method: "POST" });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");
  for (const method of ["GET", "DELETE"]) {
    const response = await mf.dispatchFetch("https://worker.test/mcp-http", { method, headers: auth });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
  }
  const response = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "MCP-Protocol-Version": "invalid" });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal((await mf.dispatchFetch("https://worker.test/mcp-http-extra", { headers: auth })).status, 404);
  assert.equal(databases(join(dir, "do")).length, 0);
});

test("concurrent request-local servers do not mix equal JSON-RPC IDs", async () => {
  await Promise.all(Array.from({ length: 12 }, async (_, i) => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "convert_file_to_markdown", arguments: { filename: `image-${i}.png`, content: "YQ==" } } });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.id, 1);
    assert.ok(data.result.content[0].text.includes(`image-${i}.png`));
    assert.equal(data.result.isError, true);
  }));
  assert.equal(databases(join(dir, "do")).length, 0);
});

test("conversion factory retains URL auto-detect, file conversion, formats and waitUntil usage", async () => {
  for (const [name, args] of [
    ["convert_file_to_markdown", { filename: "test.html", content: "PGgxPnRlc3Q8L2gxPg==" }],
    ["convert_file_to_markdown", { filename: "page.html", content: "https://source.example/page" }],
    ["convert_url_to_markdown", { url: "https://source.example/page" }],
    ["list_supported_formats", {}],
  ]) {
    const response = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } });
    const data = await response.json();
    assert.equal(data.result.isError, undefined);
    assert.ok(data.result.content[0].text.includes(name === "list_supported_formats" ? "text/html" : "# Test markdown"));
  }
  const kv = await mf.getKVNamespace("USAGE_KV");
  let total;
  for (let i = 0; i < 100; i++) {
    total = await kv.get("usage:total:calls");
    if (total === "3") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(total, "3");
  assert.equal(await kv.get("usage:total:tokens"), "21");
  assert.equal(outbound.filter((url) => url.endsWith("/ai/tomarkdown")).length, 3);
  assert.equal(databases(join(dir, "do")).length, 0);
});

test("legacy SSE init/message compatibility and fail-closed retention are maintained", async () => {
  const response = await mf.dispatchFetch("https://worker.test/mcp", { headers: { ...auth, Accept: "text/event-stream" } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  const endpoint = new TextDecoder().decode(value).match(/data: (.+)/)[1];
  const sessionId = new URL(endpoint, "https://worker.test").searchParams.get("sessionId");
  const namespace = await mf.getDurableObjectNamespace("MCP_OBJECT");
  const stub = namespace.get(namespace.idFromName(`sse:${sessionId}`));
  const snapshot = await stub.inspect();
  assert.equal(snapshot.schedules, 1);
  assert.equal(snapshot.retention.transport, "sse");
  assert.equal(snapshot.retention.disconnectedAt, null);
  assert.equal(snapshot.connections, 1);
  const init = await mf.dispatchFetch("https://worker.test" + endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } }) });
  assert.equal(init.status, 202);
  assert.ok(new TextDecoder().decode((await reader.read()).value).includes('"id":4'));
  await stub.setRetention(Date.now() - 25 * 60 * 60 * 1000);
  await stub.cleanupLegacySession();
  assert.equal((await stub.inspect()).connections, 1);
  assert.equal((await stub.inspect()).schedules, 1);
  // A rejected second stream must not break the first stream.
  const duplicate = await mf.dispatchFetch(`https://worker.test/mcp?sessionId=${sessionId}`, { headers: { ...auth, Accept: "text/event-stream" } });
  const duplicateReader = duplicate.body.getReader();
  await duplicateReader.read();
  await duplicateReader.cancel();
  assert.equal((await stub.inspect()).connections, 1);
  // Normal client cancellation, without test-only force-close RPC.
  await reader.cancel();
  // The locked SDK may retain an OPEN bridge after cancellation. In that
  // case cleanup must keep the session instead of guessing it is abandoned.
  await stub.cleanupLegacySession();
  assert.equal((await stub.inspect()).schedules, 1);

});

test("real inherited cold alarm deletes expired fixture state without reading an Agent name", async () => {
  const namespace = await mf.getDurableObjectNamespace("MCP_OBJECT");
  // Direct RPC construction intentionally bypasses setName()/onStart().
  const stub = namespace.get(namespace.idFromName("sse:cold-alarm-fixture"));
  await stub.seedColdAlarm();
  assert.equal((await stub.inspect()).schedules, 1);
  assert.equal(await stub.simulateAlarm(), 0);
});
