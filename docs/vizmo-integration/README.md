# Native client keys and Claude Code session isolation

This deployment integrates the corrected auxiliary-call and native-agent layers
from [#1279](https://github.com/rynfar/meridian/pull/1279) and
[#1280](https://github.com/rynfar/meridian/pull/1280), originating in Noah
Passalacqua's [#1211](https://github.com/rynfar/meridian/pull/1211) and
[#1231](https://github.com/rynfar/meridian/pull/1231).
`source-map.json` records incorporated commits with the original author/date.
The upstream evidence remains on those branches; it is not acceptance evidence
for this private deployment. No upstream merge or npm release is implied.

## Client keys

Set `MERIDIAN_API_KEY` to the administrator credential. Visit `/keys` using the
existing authenticated dashboard. Create a named client key and copy the value
once. Clients use `x-api-key` or `Authorization: Bearer` on Messages or Models.
Client credentials cannot read telemetry, manage keys/profiles/settings, or
cancel other sessions. The administrator credential remains valid everywhere.

`client-keys.json`, under `MERIDIAN_CONFIG_DIR` (default
`~/.config/meridian`), persists only SHA-256 digests and key metadata, with mode
0600 and atomic replacement. Preserve this file in the existing data volume.
Revocation rejects new requests immediately; it does not abort accepted work.
The single Meridian server process serializes registry mutations synchronously.
Multiple independent writer processes sharing the same registry are unsupported.

An optional `MERIDIAN_CLIENT_KEY_HASHES` JSON name-to-SHA256 object imports
legacy credentials on first use. Once the registry exists, it is authoritative;
leaving the old seed in the environment cannot resurrect revoked keys. Do not
delete the registry as a means of restarting the service. A malformed registry
fails closed for client authentication and returns a generic service error.

The key list shows active credentials only. Revocation permanently removes the
credential record and frees its name for a new key. Names of active keys are
unique regardless of capitalization. Earlier revoked records are purged on the
next registry operation. The registry file remains present even when empty, so
old environment credentials cannot be imported again.

## Cache behavior

Auto-mode classifier calls retain the root's account affinity but never acquire
its turn lease, consume recovery grants, or overwrite its session checkpoint.
Native Agent calls use a private root/agent tuple and can resume independently.
Explicit root cancellation still reaches all agent and classifier requests;
scoped cancellation leaves siblings intact. Classifier detection uses the native
client envelope, without requiring gateway hint settings on employee machines.

Inference bodies and client tool definitions are unchanged by authentication and
session classification. Meridian still bridges requests through the official
Agent SDK; these changes do not establish byte-for-byte upstream API forwarding.
New conversations and agents need their initial cache prefix built. Aggregate
cache rates can remain lower than main-turn rates because classifier calls and
new agents contribute cache creation. This does not guarantee account-policy
compatibility or resolve upstream rate limits and refusals.

For this deployment, set the existing server option
`MERIDIAN_DEFER_TOOL_THRESHOLD=0` to disable automatic tool deferral. Native
E71/E72 then retain one generated message per tested tool request. Explicit
client-deferred tools retain upstream behavior. This requires no client setting.

## Verification

Run `npm test`, `npm run typecheck`, and `npm run build`. Native-key tests cover
both header formats, unchanged bodies, admin separation, migration, persistence,
revocation, corrupt stores, input bounds and browser-origin checks. The source
includes E71/E72 actual-client harnesses and the E41 four-way passthrough matrix.
Deployment-specific live results are recorded separately after execution.

`live-verification.json` contains the sanitized deployment results. The native
proofs used Linux ARM64; they do not establish the upstream Linux x64 release gate.
