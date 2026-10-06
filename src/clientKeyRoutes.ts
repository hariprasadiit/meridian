/** Admin-only key management. Route authentication belongs to the proxy boundary. */
import { ClientKeyError, createClientKey, listClientKeys, revokeClientKey } from "./clientKeys"

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (origin === null) return true
  try {
    const source = new URL(origin), target = new URL(request.url)
    return source.origin === origin && (source.origin === target.origin
      || (source.protocol === "https:" && target.protocol === "http:" && source.hostname === target.hostname
        && (source.port === target.port || (source.port === "" && target.port === "443"))))
  } catch { return false }
}

async function boundedJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new ClientKeyError("Use application/json")
  }
  const reader = request.body?.getReader()
  if (!reader) throw new ClientKeyError("Invalid JSON")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) throw new ClientKeyError("Key request is too large")
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) }
    catch { throw new ClientKeyError("Invalid JSON") }
  } finally { await reader.cancel(); reader.releaseLock() }
}

export async function clientKeyResponse(request: Request, id?: string): Promise<Response> {
  const headers = { "Cache-Control": "no-store" }
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  if (!process.env.MERIDIAN_API_KEY) return json({ error: "Configure an admin API key before managing client keys" }, 403)
  if (request.method !== "GET" && !sameOrigin(request)) return json({ error: "Key changes require a same-origin request" }, 403)
  try {
    if (request.method === "GET") return json({ keys: listClientKeys() })
    if (request.method === "DELETE" && id) return json({ credential: revokeClientKey(id) })
    const input = await boundedJson(request)
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ClientKeyError("Use a JSON object with a name")
    return json(createClientKey((input as { name?: unknown }).name), 201)
  } catch (error) {
    if (error instanceof ClientKeyError) return json({ error: error.message }, error.status)
    return json({ error: "Client key registry is unavailable" }, 503)
  }
}
