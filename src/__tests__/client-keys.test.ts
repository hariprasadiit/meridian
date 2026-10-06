import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { createClientKey, hasValidClientKey, listClientKeys, revokeClientKey } from "../clientKeys"
import { clientKeyResponse } from "../clientKeyRoutes"
import { authEnabled, hasValidApiKey, requireAuth } from "../proxy/auth"

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
    revokeClientKey(original.id)
    expect(hasValidClientKey("old-client")).toBe(false)
    expect(listClientKeys()[0]!.revokedAt).not.toBeNull()
    expect(revokeClientKey(original.id)).toEqual(listClientKeys()[0]!)
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
})

describe("client key boundary", () => {
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
