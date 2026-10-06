/**
 * A refusal recorded on the error path must name the account that refused.
 *
 * Priority routing tries each profile in turn. Since #825 stopped forking
 * `requestId` per attempt, every attempt files under the caller's id and
 * `profileId` is the only thing that distinguishes them. The error-path
 * telemetry row wrote `model: "unknown"` and no `profileId` at all, so
 * "which account rate-limited me?" was unanswerable from telemetry. See #829.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClientKey } from "../clientKeys"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

let failingDirs = new Set<string>()
let sdkErrorAssistant = false

installSdkMock( () => ({
  query: (params: { options?: { env?: Record<string, string>; sessionId?: string; resume?: string } }) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    return (async function* () {
      if ([...failingDirs].some(f => dir.includes(f))) {
        if (sdkErrorAssistant) {
          const message = assistantMessage([{ type: "text", text: "Credit balance is too low" }])
          if (message.type === "assistant") {
            yield withMockSdkSessionId({ ...message, error: "billing_error" }, params.options)
          }
          throw new Error("Claude Code returned an error result: Credit balance is too low")
        }
        throw new Error("429 rate limit reached for this account")
      }
      yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok from " + dir }]), params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

installLoggerMock( () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock( () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { resetActiveProfile } = await import("../proxy/profiles")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { telemetryStore } = await import("../telemetry")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-errtel-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-errtel-personal" },
]

const savedEnv: Record<string, string | undefined> = {}

describe("error-path telemetry records the profile that failed", () => {
  beforeEach(() => {
    resetProcessSdkSemaphoreForTests()
    clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear?.()
    failingDirs = new Set()
    sdkErrorAssistant = false
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it.each([
    { stream: false, failover: false }, { stream: true, failover: false },
    { stream: false, failover: true }, { stream: true, failover: true },
  ])("attributes completed requests and failover hops to their authenticated key: %j", async ({ stream, failover }) => {
    const fields = ["MERIDIAN_API_KEY", "MERIDIAN_CONFIG_DIR", "MERIDIAN_CLIENT_KEY_HASHES"]
    const original = Object.fromEntries(fields.map(key => [key, process.env[key]]))
    const directory = mkdtempSync(join(tmpdir(), "meridian-key-metric-"))
    try {
      process.env.MERIDIAN_API_KEY = "owned-test-admin"
      process.env.MERIDIAN_CONFIG_DIR = directory
      delete process.env.MERIDIAN_CLIENT_KEY_HASHES
      const created = createClientKey("Owned laptop")
      if (failover) failingDirs.add("meridian-errtel-work")
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
      const requestId = crypto.randomUUID()
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId,
          authorization: `Bearer ${created.key}`, "x-meridian-client-key-id": "spoofed" },
        body: JSON.stringify({ model: "haiku", max_tokens: 128, stream, messages: [{ role: "user", content: "hello" }] }),
      }))
      expect(response.status).toBe(200)
      expect(await response.text()).toContain("ok from")
      const rows = telemetryStore.getRecent({ limit: 500 }).filter(row => row.requestId === requestId)
      expect(rows).toHaveLength(failover ? 2 : 1)
      expect(rows.every(row => row.clientKeyId === created.credential.id && row.clientKeyName === "Owned laptop")).toBe(true)
      if (failover) expect(new Set(rows.map(row => row.profileId))).toEqual(new Set(["work", "personal"]))
      expect(JSON.stringify(rows)).not.toContain(created.key)
      expect((await app.fetch(new Request("http://localhost/telemetry/client-keys", {
        headers: { "x-api-key": created.key },
      }))).status).toBe(401)
    } finally {
      for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("names the refusing profile on the failover refusal row", async () => {
    failingDirs.add("meridian-errtel-work")
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work",
    })

    const clientId = `errtel-failover-${Date.now()}`
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": clientId },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)

    const mine = telemetryStore.getRecent({ limit: 500 }).filter(m => m.requestId === clientId)
    expect(mine.length).toBeGreaterThanOrEqual(2)

    // The bug: this row had no profileId, so the only account named anywhere
    // in telemetry was the one that succeeded.
    const refusals = mine.filter(m => m.error !== null)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]!.profileId).toBe("work")

    // ...and the served row still names the account that answered, unchanged.
    const served = mine.filter(m => m.error === null)
    expect(served).toHaveLength(1)
    expect(served[0]!.profileId).toBe("personal")
  })

  it("records the initially resolved model instead of a bare \"unknown\"", async () => {
    failingDirs.add("meridian-errtel-work")
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work",
    })

    const clientId = `errtel-model-${Date.now()}`
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": clientId },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: false,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)

    const refusal = telemetryStore.getRecent({ limit: 500 })
      .find(m => m.requestId === clientId && m.error !== null)
    expect(refusal).toBeDefined()
    expect(refusal!.model).not.toBe("unknown")
    expect(refusal!.requestModel).toBe("claude-sonnet-4-5")
  })

  it("does not fabricate account telemetry for rejected malformed JSON", async () => {
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work",
    })

    const clientId = `errtel-early-${Date.now()}`
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-request-id": clientId },
      body: "{ not json",
    }))
    expect(res.status).toBe(400)
    // No profile was ever chosen, so there is genuinely nothing to name — the
    // fix must not fabricate one.
    const rows = telemetryStore.getRecent({ limit: 500 }).filter(m => m.requestId === clientId)
    expect(rows).toHaveLength(0)
  })

  it.each([false, true])("keeps a pinned failure attributed without failover, stream=%s", async (stream) => {
    failingDirs.add("meridian-errtel-work")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
    const requestId = crypto.randomUUID()
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId, "x-meridian-profile": "work" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 128, stream, messages: [{ role: "user", content: "hello" }] }),
    }))
    expect(response.status).toBe(stream ? 200 : 429)
    expect(await response.text()).toContain("rate_limit_error")
    const rows = telemetryStore.getRecent({ limit: 500 }).filter(row => row.requestId === requestId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.profileId).toBe("work")
    expect(rows[0]?.model).not.toBe("unknown")
    expect(rows[0]?.requestModel).toBe("claude-sonnet-4-5")
  })

  it("distinguishes both failed profiles under the same request id", async () => {
    failingDirs = new Set(["meridian-errtel-work", "meridian-errtel-personal"])
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
    const requestId = crypto.randomUUID()
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 128, stream: false, messages: [{ role: "user", content: "hello" }] }),
    }))
    expect(response.status).toBe(429)
    await response.text()
    const rows = telemetryStore.getRecent({ limit: 500 }).filter(row => row.requestId === requestId)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(row => row.profileId))).toEqual(new Set(["work", "personal"]))
    expect(rows.every(row => row.error !== null)).toBe(true)
  }, 15_000) // Two accounts each wait through the configured 1s + 2s retry delays.

  it("does not mistake an SDK error assistant for committed user content", async () => {
    sdkErrorAssistant = true
    failingDirs.add("meridian-errtel-work")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
    const requestId = crypto.randomUUID()
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ model: "haiku", max_tokens: 128, stream: false, messages: [{ role: "user", content: "hello" }] }),
    }))
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("ok from")
    const rows = telemetryStore.getRecent({ limit: 500 }).filter(row => row.requestId === requestId)
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.error !== null)?.profileId).toBe("work")
    expect(rows.find(row => row.error === null)?.profileId).toBe("personal")
  })
})
