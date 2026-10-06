/** Loopback-only key UI fixture using the actual registry/routes, without account credentials. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { clientKeyResponse } from "../src/clientKeyRoutes"
import { createClientKey, revokeClientKey } from "../src/clientKeys"
import { keysPageHtml } from "../src/telemetry/keysPage"

const directory = mkdtempSync(join(tmpdir(), "meridian-key-list-browser-"))
process.env.MERIDIAN_CONFIG_DIR = directory
process.env.MERIDIAN_API_KEY = "owned-browser-fixture-admin"
delete process.env.MERIDIAN_CLIENT_KEY_HASHES
const retired = createClientKey("Retired fixture")
revokeClientKey(retired.credential.id)
createClientKey("Active fixture")

const app = new Hono()
app.get("/keys", c => c.html(keysPageHtml))
app.get("/keys/api", c => clientKeyResponse(c.req.raw))
app.post("/keys/api", c => clientKeyResponse(c.req.raw))
app.delete("/keys/api/:id", c => clientKeyResponse(c.req.raw, c.req.param("id")))
app.get("/health", c => c.json({ status: "healthy" }))
app.get("/build-status", c => c.json({ enabled: false }))
app.get("/profiles/list", c => c.json({ profiles: [] }))
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
console.log(JSON.stringify({ fixture: true, url: `http://127.0.0.1:${server.port}/keys` }))
process.on("SIGTERM", () => { server.stop(true); rmSync(directory, { recursive: true, force: true }); process.exit(0) })
