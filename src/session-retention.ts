// Only ephemeral legacy MCP transport state lives in these Durable Objects.
// This controller is deliberately disabled until the operator opts in.
export const SESSION_RETENTION_KEY = "markdown:mcp:legacy-retention:v1";
export const CLEANUP_CALLBACK = "cleanupLegacySession";
export const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;

interface RetentionRecord {
  version: 1;
  transport: "sse";
  lastActivityAt: number;
  // null while connected or until a disconnect is first observed.
  disconnectedAt: number | null;
}

interface RetentionStore {
  enabled(): boolean;
  read(): Promise<unknown>;
  write(record: RetentionRecord): Promise<void>;
  hasConnections(): boolean;
  schedules(): { id: string }[];
  schedule(): Promise<void>;
  cancel(id: string): Promise<unknown>;
  exclusive(callback: () => Promise<void>): Promise<void>;
  destroy(): Promise<void>;
  now?: () => number;
}

function validRecord(value: unknown): value is RetentionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RetentionRecord>;
  return record.version === 1 && record.transport === "sse" &&
    typeof record.lastActivityAt === "number" && Number.isFinite(record.lastActivityAt) &&
    record.lastActivityAt >= 0 &&
    (record.disconnectedAt === null || (typeof record.disconnectedAt === "number" &&
      Number.isFinite(record.disconnectedAt) && record.disconnectedAt >= 0));
}

export class LegacySessionRetention {
  constructor(private readonly store: RetentionStore) {}

  private now(): number { return this.store.now?.() ?? Date.now(); }

  private async cancel(): Promise<void> {
    for (const task of this.store.schedules()) await this.store.cancel(task.id);
  }

  private async ensureSchedule(): Promise<void> {
    if (this.store.schedules().length === 0) await this.store.schedule();
  }

  async start(isLegacySse: boolean): Promise<void> {
    if (!this.store.enabled() || !isLegacySse) { await this.cancel(); return; }
    const record = await this.store.read();
    // Unknown pre-existing objects get a full observation window, never an
    // inferred age. Invalid metadata is left untouched and cannot authorize deletion.
    if (record === undefined) {
      const now = this.now();
      await this.store.write({ version: 1, transport: "sse", lastActivityAt: now, disconnectedAt: now });
    } else if (!validRecord(record)) return;
    await this.ensureSchedule();
  }

  async touch(event: "message" | "connect" | "close" = "message"): Promise<void> {
    if (!this.store.enabled()) return;
    const record = await this.store.read();
    if (!validRecord(record)) return;
    const now = this.now();
    const disconnectedAt = event === "connect" ? null : event === "close"
      ? (this.store.hasConnections() ? null : now) : record.disconnectedAt;
    await this.store.write({ ...record, disconnectedAt, lastActivityAt: Math.max(record.lastActivityAt, now) });
    await this.ensureSchedule();
  }

  async cleanup(): Promise<void> {
    if (!this.store.enabled()) { await this.cancel(); return; }
    // Prevent a reconnect/message from arriving between the final check and
    // deleteAll() inside Agent.destroy(). Active connections always win.
    await this.store.exclusive(async () => {
      const record = await this.store.read();
      if (!validRecord(record) || this.store.hasConnections()) return;
      // A close event can be queued behind this alarm, or lost on restart.
      // First observation of a disconnected transport starts a fresh window.
      if (record.disconnectedAt === null) {
        const now = this.now();
        await this.store.write({ ...record, disconnectedAt: now, lastActivityAt: Math.max(record.lastActivityAt, now) });
        return;
      }
      if (this.now() - Math.max(record.lastActivityAt, record.disconnectedAt) < SESSION_RETENTION_MS) return;
      await this.store.destroy();
    });
  }
}
