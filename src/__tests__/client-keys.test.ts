import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { createClientKey, hasValidClientKey, listClientKeys, revokeClientKey } from "../clientKeys"
import { clientKeyResponse } from "../clientKeyRoutes"
import { authEnabled, clientKeyMetric, hasValidApiKey, requireAuth } from "../proxy/auth"

let directory: string
let saved: Record<string, string | undefined>
beforeEach(() => {
  saved = Object.fromEntries(["MERIDIAN_CONFIG_DIR", "MERIDIAN_API_KEY", "MERIDIAN_CLIENT_KEY_HASHES"].map(key => [key, process.env[key]]))
  directory = mkdtempSync(join(tmpdir(), "meridian-client-keys-"))
  process.env.MERIDIAN_CONFIG_DIR = directory
  process.env.MERIDIAN_API_KEY = "test-admin"
  delete process.env.MERIDIAN_CLIENT_KEY_HASHES
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
})
const file = () => join(directory, "client-keys.json")
function app() {
  const app = new Hono()
  app.use("*", requireAuth)
  app.get("/keys/api", c => clientKeyResponse(c.req.raw))
  app.post("/keys/api", c => clientKeyResponse(c.req.raw))
  app.delete("/keys/api/:id", c => clientKeyResponse(c.req.raw, c.req.param("id")))
  app.get("/v1/models", c => c.json({ data: [] }))
  app.post("/v1/messages", async c => new Response(await c.req.text(), { headers: { "x-test-header": c.req.header("x-test-header")! } }))
  app.get("/telemetry", c => c.json({ private: true }))
  return app
}
const request = (path: string, key = "test-admin", options: RequestInit = {}) => new Request(`http://meridian.test${path}`, {
  ...options, headers: { "x-api-key": key, ...options.headers },
})

describe("native client key registry", () => {
  it("returns a secret once, persists only its hash, and restores metadata on reload", () => {
    const created = createClientKey("laptop")
    expect(created.key).toMatch(/^mrn_[a-f0-9]{64}$/)
    expect(hasValidClientKey(created.key)).toBe(true)
    expect(hasValidClientKey("wrong")).toBe(false)
    const bytes = readFileSync(file(), "utf8")
    expect(bytes).not.toContain(created.key)
    expect(bytes).toContain(createHash("sha256").update(created.key).digest("hex"))
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(listClientKeys()).toEqual([created.credential])
    expect(JSON.stringify(listClientKeys())).not.toContain("hash")
  })
  it("imports old credentials once and never resurrects a revoked seed on reload", () => {
    process.env.MERIDIAN_CLIENT_KEY_HASHES = JSON.stringify({ existing: createHash("sha256").update("old-client").digest("hex") })
    expect(hasValidClientKey("old-client")).toBe(true)
    const original = listClientKeys()[0]!
    const revoked = revokeClientKey(original.id)
    expect(hasValidClientKey("old-client")).toBe(false)
    expect(listClientKeys()).toEqual([])
    expect(revoked.revokedAt).not.toBeNull()
    expect(JSON.parse(readFileSync(file(), "utf8")).keys).toEqual([])
    expect(() => revokeClientKey(original.id)).toThrow("not found")
    expect(hasValidClientKey("old-client")).toBe(false)
  })
  it("rejects malformed registries instead of accepting credentials", () => {
    createClientKey("client")
    writeFileSync(file(), "{broken")
    expect(() => hasValidClientKey("anything")).toThrow()
    expect(() => listClientKeys()).toThrow()
  })
  it("validates names, duplicates and IDs without changing stored keys", () => {
    createClientKey("client")
    const before = readFileSync(file(), "utf8")
    for (const name of ["", " ", "line\nfeed", "x".repeat(65), null, 1]) expect(() => createClientKey(name)).toThrow()
    expect(() => createClientKey("client")).toThrow("already")
    expect(() => revokeClientKey("unknown")).toThrow("not found")
    expect(readFileSync(file(), "utf8")).toBe(before)
    revokeClientKey(listClientKeys()[0]!.id)
    expect(() => createClientKey("client")).not.toThrow()
  })
  it("rejects active duplicate names but frees a deleted key's name", () => {
    const original = createClientKey("Laptop")
    for (const name of ["Laptop", "laptop", "LAPTOP"]) expect(() => createClientKey(name)).toThrow("already")
    revokeClientKey(original.credential.id)
    expect(listClientKeys()).toEqual([])
    expect(hasValidClientKey(original.key)).toBe(false)
    expect(JSON.parse(readFileSync(file(), "utf8")).keys).toEqual([])
    const other = createClientKey("LAPTOP")
    expect(other.key).not.toBe(original.key)
    expect(listClientKeys()).toEqual([other.credential])
    expect(hasValidClientKey(other.key)).toBe(true)
    expect(hasValidClientKey(original.key)).toBe(false)
  })
  it("purges previously revoked records while preserving active credentials and the authoritative file", () => {
    const removed = createClientKey("Retired"), active = createClientKey("Active")
    const registry = JSON.parse(readFileSync(file(), "utf8"))
    registry.keys[0].revokedAt = new Date().toISOString()
    writeFileSync(file(), JSON.stringify(registry))
    expect(listClientKeys()).toEqual([active.credential])
    expect(JSON.parse(readFileSync(file(), "utf8")).keys).toEqual([registry.keys[1]])
    expect(hasValidClientKey(removed.key)).toBe(false)
    expect(hasValidClientKey(active.key)).toBe(true)
    const replacement = createClientKey("retired")
    expect(hasValidClientKey(replacement.key)).toBe(true)
    expect(hasValidClientKey(removed.key)).toBe(false)
  })
})

describe("client key boundary", () => {
  it("attributes both valid credential headers using public metadata only, without trusting client identity headers", async () => {
    const { key, credential } = createClientKey("Laptop")
    const server = new Hono()
    server.use("*", requireAuth)
    server.post("/v1/messages", c => c.json(clientKeyMetric(c)))
    const credentials: Record<string, string>[] = [{ "x-api-key": key }, { authorization: `Bearer ${key}` }]
    for (const headers of credentials) {
      const response = await server.fetch(new Request("http://meridian.test/v1/messages", {
        method: "POST", headers: { ...headers, "x-meridian-client-key-id": "spoofed" }, body: "{}",
      }))
      expect(await response.json()).toEqual({ clientKeyId: credential.id, clientKeyName: "Laptop" })
    }
    const admin = await server.fetch(request("/v1/messages", "test-admin", { method: "POST", body: "{}" }))
    expect(await admin.json()).toEqual({ clientKeyId: "admin", clientKeyName: "Administrator" })
    expect((await server.fetch(request("/v1/messages", "invalid", { method: "POST", body: "{}" }))).status).toBe(401)
  })
  it("accepts both client headers, forwards body/header unchanged, and denies all administration", async () => {
    const server = app(), { key } = createClientKey("employee")
    const credentials: Record<string, string>[] = [{ "x-api-key": key }, { authorization: `Bearer ${key}` }]
    for (const headers of credentials) {
      expect((await server.fetch(new Request("http://meridian.test/v1/models", { headers }))).status).toBe(200)
      const body = '{"messages":[{"role":"user","content":"owned fixture"}],"model":"claude-opus-5-5"}'
      const response = await server.fetch(new Request("http://meridian.test/v1/messages?probe=1", { method: "POST", headers: { ...headers, "x-test-header": "kept" }, body }))
      expect(await response.text()).toBe(body)
      expect(response.headers.get("x-test-header")).toBe("kept")
      for (const path of ["/keys/api", "/telemetry", "/v1/sessions/root/cancel"]) expect((await server.fetch(new Request(`http://meridian.test${path}`, { headers }))).status).toBe(401)
      expect((await server.fetch(request("/keys/api", key, { method: "POST", body: '{}' }))).status).toBe(401)
    }
    expect(hasValidApiKey(new Headers({ "x-api-key": key }))).toBe(false)
    expect((await server.fetch(request("/v1/models", "wrong"))).status).toBe(401)
  })
  it("revokes immediately, fails closed on corruption, and leaves the admin able to diagnose", async () => {
    const server = app(), created = createClientKey("employee")
    expect((await server.fetch(request(`/keys/api/${created.credential.id}`, "test-admin", { method: "DELETE" }))).status).toBe(200)
    expect((await server.fetch(request("/v1/models", created.key))).status).toBe(401)
    writeFileSync(file(), "{broken")
    expect((await server.fetch(request("/v1/models", created.key))).status).toBe(503)
    expect((await server.fetch(request("/keys/api"))).status).toBe(503)
    expect((await server.fetch(request("/v1/models"))).status).toBe(200)
  })
  it("lists only active keys and rejects duplicate names through the API", async () => {
    const server = app(), retired = createClientKey("Employee"), active = createClientKey("Other")
    await server.fetch(request(`/keys/api/${retired.credential.id}`, "test-admin", { method: "DELETE" }))
    const listed = await server.fetch(request("/keys/api"))
    expect(await listed.json()).toEqual({ keys: [active.credential] })
    const before = readFileSync(file(), "utf8")
    for (const name of ["other", "Other"]) {
      const response = await server.fetch(request("/keys/api", "test-admin", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }),
      }))
      expect(response.status).toBe(409)
      expect((await response.json() as { error: string }).error).toContain("already")
    }
    expect(readFileSync(file(), "utf8")).toBe(before)
    expect((await server.fetch(request("/v1/models", retired.key))).status).toBe(401)
    expect((await server.fetch(request("/v1/models", active.key))).status).toBe(200)
    const replacement = await server.fetch(request("/keys/api", "test-admin", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "employee" }),
    }))
    expect(replacement.status).toBe(201)
    const result = await replacement.json() as { key: string }
    expect((await server.fetch(request("/v1/models", result.key))).status).toBe(200)
    expect((await server.fetch(request("/v1/models", retired.key))).status).toBe(401)
  })
  it("prevents key management without an admin and does not silently open configured clients", async () => {
    const created = createClientKey("employee")
    delete process.env.MERIDIAN_API_KEY
    expect(authEnabled()).toBe(true)
    expect(hasValidApiKey(new Headers())).toBe(false)
    expect((await app().fetch(request("/v1/models", created.key))).status).toBe(401)
    expect((await clientKeyResponse(request("/keys/api"))).status).toBe(403)
  })
  it("enforces same-origin browser changes, allows TLS termination and never trusts forwarding headers", async () => {
    const server = app()
    for (const origin of ["https://foreign.test", "null", "https://meridian.test:444", "https://meridian.test/path"]) {
      const response = await server.fetch(request("/keys/api", "test-admin", { method: "POST", headers: { origin, "x-forwarded-host": "foreign.test", "content-type": "application/json" }, body: '{"name":"blocked"}' }))
      expect(response.status).toBe(403)
    }
    const response = await server.fetch(request("/keys/api", "test-admin", { method: "POST", headers: { origin: "https://meridian.test", "content-type": "application/json" }, body: '{"name":"allowed"}' }))
    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const body = await response.json() as { key: string }
    const listed = await server.fetch(request("/keys/api"))
    expect(await listed.text()).not.toContain(body.key)
    expect(listed.headers.get("cache-control")).toBe("no-store")
  })
  it("bounds input, rejects form posts and preserves keys after failed mutations", async () => {
    const server = app()
    for (const [body, type] of [["name=bad", "application/x-www-form-urlencoded"], ["{}", "application/json"], ["{", "application/json"], ['{"name":"' + "x".repeat(5000) + '"}', "application/json"]]) {
      expect((await server.fetch(request("/keys/api", "test-admin", { method: "POST", headers: { "content-type": type! }, body }))).status).toBe(400)
    }
    expect(listClientKeys()).toEqual([])
  })
})
