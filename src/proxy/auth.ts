/**
 * Optional API key authentication middleware.
 *
 * When MERIDIAN_API_KEY is set, requests to protected routes must include
 * a matching key via `x-api-key` header or `Authorization: Bearer` header.
 * Client keys are limited to inference routes; management always uses the admin key.
 * When neither admin nor client keys are configured, routes remain open for local use.
 *
 * Uses constant-time comparison to prevent timing attacks.
 */

import { createHmac, timingSafeEqual } from "node:crypto"
import type { Context, Next } from "hono"
import { clientKeysConfigured, hasValidClientKey } from "../clientKeys"

function getConfiguredKey(): string | undefined {
  return process.env.MERIDIAN_API_KEY || undefined
}

/**
 * Whether API key authentication is enabled.
 * True when MERIDIAN_API_KEY is set to a non-empty value.
 */
export function authEnabled(): boolean {
  return Boolean(getConfiguredKey()) || clientKeysConfigured()
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Hashes both values to ensure equal-length comparison regardless of input.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHmac("sha256", "meridian").update(a).digest()
  const hashB = createHmac("sha256", "meridian").update(b).digest()
  return timingSafeEqual(hashA, hashB)
}

/** Shared by the Hono default backend and standard-Request runtime backends. */
export function hasValidApiKey(headers: Headers): boolean {
  const key = getConfiguredKey()
  if (!key) return !clientKeysConfigured()
  const authorization = headers.get("authorization")
  const provided = headers.get("x-api-key") || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined)
  return Boolean(provided && safeCompare(provided, key))
}

/**
 * Extract the API key from the request.
 * Checks x-api-key header first, then Authorization: Bearer.
 */
function extractKey(c: Context): string | undefined {
  const apiKey = c.req.header("x-api-key")
  if (apiKey) return apiKey

  const auth = c.req.header("authorization")
  if (auth?.startsWith("Bearer ")) return auth.slice(7)

  return undefined
}

/**
 * Hono middleware that rejects requests without a valid API key.
 * No-op when MERIDIAN_API_KEY is not set.
 */
export async function requireAuth(c: Context, next: Next) {
  const key = getConfiguredKey()
  if (!key && !clientKeysConfigured()) return next()

  const provided = extractKey(c)
  if (key && provided && safeCompare(provided, key)) return next()
  const path = c.req.path
  const inference = (c.req.method === "POST" && ["/v1/messages", "/messages", "/v1/messages/count_tokens"].includes(path))
    || (["GET", "HEAD"].includes(c.req.method) && path === "/v1/models")
  if (key && provided && inference && clientKeysConfigured()) {
    try { if (hasValidClientKey(provided)) return next() }
    catch { return c.json({ type: "error", error: { type: "api_error", message: "Client key registry is unavailable" } }, 503) }
  }
  return c.json({
      type: "error",
      error: {
        type: "authentication_error",
        message: "Invalid or missing API key",
      },
  }, 401)
}
