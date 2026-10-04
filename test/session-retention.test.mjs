import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["src/session-retention.ts"], bundle: true, format: "esm", write: false });
const { LegacySessionRetention, SESSION_RETENTION_MS } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

function fixture({ enabled = true, record, connected = false, schedules = [] } = {}) {
  const state = { enabled, record, connected, schedules, now: SESSION_RETENTION_MS + 100, destroyed: 0, exclusive: 0 };
  const controller = new LegacySessionRetention({
    enabled: () => state.enabled,
    read: async () => state.record,
    write: async (next) => { state.record = next; },
    hasConnections: () => state.connected,
    schedules: () => state.schedules,
    schedule: async () => { state.schedules.push({ id: "cleanup" }); },
    cancel: async (id) => { state.schedules = state.schedules.filter((task) => task.id !== id); },
    exclusive: async (callback) => { state.exclusive++; await callback(); },
    destroy: async () => { state.destroyed++; },
    now: () => state.now,
  });
  return { state, controller };
}

test("cleanup is opt-in and removes only its supplied cleanup schedules when disabled", async () => {
  const { state, controller } = fixture({ enabled: false, schedules: [{ id: "cleanup" }] });
  await controller.start(true);
  await controller.touch();
  await controller.cleanup();
  assert.equal(state.record, undefined);
  assert.equal(state.destroyed, 0);
  assert.equal(state.schedules.length, 0);
});

test("unknown old object gets a full observation window; restarts do not refresh it", async () => {
  const { state, controller } = fixture();
  await controller.start(true);
  const initial = state.record.lastActivityAt;
  state.now += 10;
  await controller.start(true);
  await controller.start(true);
  assert.equal(state.record.lastActivityAt, initial);
  assert.equal(state.schedules.length, 1);
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
});

test("non-SSE sessions are never armed", async () => {
  const { state, controller } = fixture();
  await controller.start(false);
  assert.equal(state.record, undefined);
  assert.equal(state.schedules.length, 0);
});

test("missing, corrupt, and future metadata never permit deletion", async () => {
  for (const record of [undefined, {}, null, { version: 1, transport: "sse", lastActivityAt: NaN }, { version: 1, transport: "sse", lastActivityAt: -1 }, { version: 1, transport: "http", lastActivityAt: 0, disconnectedAt: 0 }, { version: 1, transport: "sse", lastActivityAt: 1e20, disconnectedAt: 1e20 }]) {
    const { state, controller } = fixture({ record });
    await controller.cleanup();
    assert.equal(state.destroyed, 0);
  }
});

test("an active connection protects even old metadata", async () => {
  const { state, controller } = fixture({ connected: true, record: { version: 1, transport: "sse", lastActivityAt: 0, disconnectedAt: 0 } });
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
});

test("activity and disconnection restart the idle window without duplicating schedules", async () => {
  const { state, controller } = fixture();
  await controller.start(true);
  state.now += SESSION_RETENTION_MS;
  await controller.touch();
  await controller.touch();
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
  assert.equal(state.schedules.length, 1);
  state.now += SESSION_RETENTION_MS - 1;
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
  state.now++;
  await controller.cleanup();
  assert.equal(state.destroyed, 1);
});

test("cold cleanup needs only persisted metadata and runs under an exclusive gate", async () => {
  const { state, controller } = fixture({ record: { version: 1, transport: "sse", lastActivityAt: 100, disconnectedAt: 100 } });
  await controller.cleanup();
  assert.equal(state.destroyed, 1);
  assert.equal(state.exclusive, 1);
});

test("switching cleanup off stops an already-armed schedule", async () => {
  const { state, controller } = fixture();
  await controller.start(true);
  state.enabled = false;
  state.now += SESSION_RETENTION_MS * 2;
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
  assert.equal(state.schedules.length, 0);
});


test("a queued or lost close event starts a full disconnect window before deletion", async () => {
  const { state, controller } = fixture({ record: { version: 1, transport: "sse", lastActivityAt: 0, disconnectedAt: null } });
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
  assert.equal(state.record.disconnectedAt, state.now);
  state.now += SESSION_RETENTION_MS - 1;
  await controller.cleanup();
  assert.equal(state.destroyed, 0);
  state.now++;
  await controller.cleanup();
  assert.equal(state.destroyed, 1);
});

test("connect clears the idle marker, and last close establishes it again", async () => {
  const { state, controller } = fixture();
  await controller.start(true);
  await controller.touch("connect");
  assert.equal(state.record.disconnectedAt, null);
  state.connected = true;
  await controller.touch("close");
  assert.equal(state.record.disconnectedAt, null);
  state.connected = false;
  state.now += 10;
  await controller.touch("close");
  assert.equal(state.record.disconnectedAt, state.now);
  state.now += SESSION_RETENTION_MS;
  await controller.cleanup();
  assert.equal(state.destroyed, 1);
});
