#!/usr/bin/env bun
// Real telemetry HTTP routes and dashboard with synthetic usage only. No model calls.
// E2E_PORT=42234 bun scripts/e2e-client-key-telemetry.mjs
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

const root = mkdtempSync(join(tmpdir(), 'meridian-key-telemetry-ui-'))
process.env.MERIDIAN_CONFIG_DIR = root
process.env.MERIDIAN_TELEMETRY_PERSIST = '0'
const { telemetryStore, createTelemetryRoutes } = await import('../src/telemetry/index.ts')
const { createClientKey, listClientKeys, revokeClientKey } = await import('../src/clientKeys.ts')
const first = createClientKey('Laptop').credential
const second = createClientKey('Desktop').credential
const deleted = createClientKey('Reused name').credential
revokeClientKey(deleted.id)
const replacement = createClientKey('Reused name').credential
const hostile = createClientKey('<img src=x onerror="window.keyLabelExecuted=true">').credential
function record(key, requestId, inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens) {
  telemetryStore.record({
    requestId, timestamp: Date.now(), model: 'claude-opus-5-5', adapter: 'claude-code',
    mode: 'stream', isResume: false, isPassthrough: true, status: 200,
    queueWaitMs: 0, proxyOverheadMs: 1, ttfbMs: 2, upstreamDurationMs: 3,
    totalDurationMs: 4, contentBlocks: 1, textEvents: 1, error: null,
    inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens,
    profileId: 'synthetic-account', routeKind: 'active',
    ...(key ? { clientKeyId: key.id, clientKeyName: key.name } : {}),
  })
}
record(first, 'laptop-1', 11, 100, 9, 7)
record(first, 'laptop-2', 13, 200, 10, 8)
record(second, 'desktop-1', 999, 20, 30, 40)
record(deleted, 'deleted-1', 5, 50, 6, 7)
record(hostile, 'escaped-name', 1, 2, 3, 4)
record(null, 'legacy-1', 2, 3, 4, 5)
const app = new Hono()
app.route('/telemetry', createTelemetryRoutes({
  getClientKeys: () => listClientKeys().map(({ id, name }) => ({ id, name })),
}))
app.get('/health', c => c.json({ version: 'synthetic-key-filter-fixture', activeProfile: 'synthetic-account' }))
app.get('/profiles/list', c => c.json({ profiles: [], active: null }))
app.get('/profiles/health', c => c.json({ spent: [], exhausted: [] }))
app.get('/build-status', c => c.json({ supported: false }))
app.get('/fixture/state', c => c.json({ first, second, deleted, replacement, hostile }))
if (process.env.E2E_BASELINE_HTML) {
  const before = readFileSync(process.env.E2E_BASELINE_HTML, 'utf8')
  app.get('/fixture/before', c => c.html(before))
}
const server = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.E2E_PORT || 42234), fetch: app.fetch })
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}/telemetry`, synthetic: true }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
  process.exit(0)
})
