import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { MemoryTelemetryStore } from "../telemetry/store"
import { createSqliteStores } from "../telemetry/sqlite"
import { createTelemetryRoutes, telemetryStore } from "../telemetry"
import type { ITelemetryStore, RequestMetric, TelemetrySummary, TelemetryClientKey } from "../telemetry/types"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); telemetryStore.clear() })
function metric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return { requestId: crypto.randomUUID(), timestamp: Date.now(), model: "opus", mode: "non-stream",
    isResume: false, isPassthrough: true, status: 200, queueWaitMs: 0, proxyOverheadMs: 1,
    ttfbMs: 2, upstreamDurationMs: 3, totalDurationMs: 4, contentBlocks: 1, textEvents: 0,
    error: null, inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 100, cacheCreationInputTokens: 9,
    ...overrides }
}
function store(kind: "memory" | "sqlite"): ITelemetryStore {
  if (kind === "memory") return new MemoryTelemetryStore(20)
  const dir = mkdtempSync(join(tmpdir(), "meridian-key-telemetry-"))
  const stores = createSqliteStores(join(dir, "telemetry.db"), 7)
  cleanups.push(() => { stores.close(); rmSync(dir, { recursive: true, force: true }) })
  return stores.telemetry
}

for (const kind of ["memory", "sqlite"] as const) describe(`${kind} API key telemetry`, () => {
  it("filters by stable key ID before limiting, separating reused names and unattributed rows", () => {
    const s = store(kind), now = Date.now()
    s.record(metric({ requestId: "a", timestamp: now - 2, clientKeyId: "key-a", clientKeyName: "Laptop" }))
    s.record(metric({ requestId: "legacy", timestamp: now - 1 }))
    s.record(metric({ requestId: "b", timestamp: now, clientKeyId: "key-b", clientKeyName: "Laptop" }))
    expect(s.getRecent({ clientKeyId: "key-a", limit: 1 }).map(m => m.requestId)).toEqual(["a"])
    expect(s.getRecent({ clientKeyId: "key-b" }).map(m => m.requestId)).toEqual(["b"])
    expect(s.getRecent({ clientKeyId: "unattributed" }).map(m => m.requestId)).toEqual(["legacy"])
    expect(s.getRecent({ clientKeyId: "missing' OR 1=1 --" })).toEqual([])
    expect(s.getRecent()).toHaveLength(3)
  })
  it("computes request, error, cache and non-cache token totals only from the selected key", () => {
    const s = store(kind)
    s.record(metric({ clientKeyId: "key-a", clientKeyName: "A" }))
    s.record(metric({ clientKeyId: "key-a", clientKeyName: "A", status: 429, error: "rate_limit_error" }))
    s.record(metric({ clientKeyId: "key-b", clientKeyName: "B", inputTokens: 9999 }))
    s.record(metric())
    const summary = s.summarize(3600000, { clientKeyId: "key-a" })
    expect(summary.totalRequests).toBe(2)
    expect(summary.errorCount).toBe(1)
    expect(summary.tokenUsage).toMatchObject({ totalInputTokens: 22, totalOutputTokens: 14,
      totalCacheReadTokens: 200, totalCacheCreationTokens: 18 })
    expect(s.summarize(3600000, { clientKeyId: "unattributed" }).totalRequests).toBe(1)
    expect(s.summarize(3600000, { clientKeyId: "missing" }).totalRequests).toBe(0)
  })
  it("keeps historical key choices separate even when their names are the same", () => {
    const s = store(kind)
    s.record(metric({ clientKeyId: "key-a", clientKeyName: "Laptop" }))
    s.record(metric({ clientKeyId: "key-a", clientKeyName: "Laptop" }))
    s.record(metric({ clientKeyId: "key-b", clientKeyName: "Laptop" }))
    s.record(metric())
    expect(s.getClientKeys().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "key-a", name: "Laptop" }, { id: "key-b", name: "Laptop" },
    ])
  })
})

describe("API key telemetry routes", () => {
  it("applies the same filter to requests, summary, and routing without exposing global tree counters", async () => {
    telemetryStore.clear()
    telemetryStore.record(metric({ clientKeyId: "key-a", clientKeyName: "A", profileId: "work", routeKind: "active" }))
    telemetryStore.record(metric({ clientKeyId: "key-b", clientKeyName: "B", profileId: "other", routeKind: "active" }))
    telemetryStore.record(metric())
    const tree = { tracked: 3, linked: 2, propagations: 1, cancelledDescendants: 1 }
    const app = new Hono().route("/telemetry", createTelemetryRoutes({ getSessionTree: () => tree }))
    const rows = await (await app.request("/telemetry/requests?clientKeyId=key-a")).json() as RequestMetric[]
    expect(rows).toHaveLength(1); expect(rows[0]?.clientKeyId).toBe("key-a")
    const summary = await (await app.request("/telemetry/summary?clientKeyId=key-a")).json() as TelemetrySummary
    expect(summary.totalRequests).toBe(1); expect(summary.tokenUsage?.totalInputTokens).toBe(11)
    expect(summary).not.toHaveProperty("sessionTree")
    expect(await (await app.request("/telemetry/summary")).json()).toHaveProperty("sessionTree", tree)
    const routes = await (await app.request("/telemetry/routes?clientKeyId=key-a")).json() as { requests: number; byProfile: Record<string, unknown> }
    expect(routes.requests).toBe(1); expect(Object.keys(routes.byProfile)).toEqual(["work"])
    expect(((await (await app.request("/telemetry/summary?clientKeyId=unattributed")).json()) as TelemetrySummary).totalRequests).toBe(1)
  })
  it("offers unused active keys and historical deleted keys without merging a reused name", async () => {
    telemetryStore.clear()
    telemetryStore.record(metric({ clientKeyId: "old-id", clientKeyName: "Laptop" }))
    const app = new Hono().route("/telemetry", createTelemetryRoutes({
      getClientKeys: () => [{ id: "new-id", name: "Laptop" }],
    }))
    const response = await app.request("/telemetry/client-keys")
    expect(response.status).toBe(200)
    const body = await response.json() as { keys: (TelemetryClientKey & { active?: boolean })[] }
    expect(body.keys).toEqual([
      { id: "new-id", name: "Laptop", active: true }, { id: "old-id", name: "Laptop", active: false },
    ])
    expect(JSON.stringify(body)).not.toContain("hash")
  })
})
