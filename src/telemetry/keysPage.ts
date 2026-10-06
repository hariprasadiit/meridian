import { profileBarCss, profileBarHtml, profileBarJs, themeCss } from "./profileBar"

export const keysPageHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meridian — API Keys</title><link rel="icon" type="image/svg+xml" href="/telemetry/icon.svg">
<style>
${themeCss}
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
${profileBarCss}
.container { max-width: 960px; margin: auto; padding: 24px; }
h1 { margin: 0 0 4px; font-size: 22px; }
.subtitle, .note { color: var(--muted); }
.subtitle { margin: 0 0 24px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
label { display: block; font-weight: 500; margin-bottom: 8px; }
.create-row { display: flex; gap: 12px; }
input, textarea { min-width: 0; background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font: inherit; }
input { flex: 1; }
button { color: var(--text); background: var(--surface2); border: 1px solid var(--border); border-radius: 6px; padding: 9px 14px; font: inherit; cursor: pointer; }
button.primary { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
button.danger { color: var(--red); }
button:disabled { opacity: .55; cursor: wait; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.note { margin: 10px 0 0; font-size: 13px; }
.message { margin: 0 0 16px; min-height: 21px; }
.message.error { color: var(--red); }
.key-list { padding: 0; list-style: none; margin: 0; }
.key-row { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-top: 1px solid var(--border); }
.key-row:first-child { border-top: 0; }
.key-detail { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.key-name { font-weight: 600; }
.key-meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
.status { color: var(--green); font-size: 12px; white-space: nowrap; }
.revoked { color: var(--muted); }
.list-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { font-size: 16px; margin: 0; }
dialog { color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 24px; width: min(540px, calc(100% - 32px)); }
dialog::backdrop { background: rgba(0,0,0,.65); }
dialog h2 { font-size: 20px; }
dialog textarea { width: 100%; resize: none; font: 13px/1.6 'SF Mono', Consolas, monospace; color: var(--accent2); }
.dialog-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 16px; }
@media (max-width: 600px) { .container { padding: 16px; } .card { padding: 16px; } .create-row { flex-direction: column; } .key-row { flex-wrap: wrap; } .key-detail { flex-basis: 70%; } }
</style></head><body>
${profileBarHtml}
<main class="container">
<h1>API Keys</h1><p class="subtitle">Give each person or device its own credential for the Claude API.</p>
<p id="message" class="message" role="status" aria-live="polite"></p>
<section class="card" aria-label="Create API key">
<form id="create-form"><label for="key-name">Key name</label><div class="create-row">
<input id="key-name" name="name" placeholder="e.g. Priya’s laptop" maxlength="64" autocomplete="off" required>
<button id="create-button" class="primary" type="submit">Create key</button></div></form>
<p class="note">Keys can call Messages and Models. Dashboard access uses the administrator credential.</p>
</section>
<section class="card" aria-labelledby="list-title"><div class="list-heading"><h2 id="list-title">Client keys</h2><button id="refresh" type="button">Refresh</button></div>
<p id="empty" class="note">Loading keys…</p><ul id="keys" class="key-list"></ul></section>
<p class="note">Changes apply immediately. Revoking a key prevents new requests; requests already running can finish.</p>
</main>
<dialog id="created-dialog" aria-labelledby="created-title"><h2 id="created-title">Your key is ready</h2>
<p>Copy it now. Meridian stores its hash and cannot show this key again.</p>
<label for="new-key">API key</label><textarea id="new-key" rows="3" readonly spellcheck="false"></textarea>
<p id="copy-message" class="note" role="status" aria-live="polite"></p>
<div class="dialog-actions"><button id="copy-key" class="primary" type="button">Copy key</button><button id="close-dialog" type="button">Done</button></div></dialog>
<dialog id="revoke-dialog" aria-labelledby="revoke-title"><h2 id="revoke-title">Revoke key?</h2>
<p id="revoke-description"></p><div class="dialog-actions"><button id="cancel-revoke" type="button">Cancel</button><button id="confirm-revoke" class="danger" type="button">Revoke key</button></div></dialog>
<script>
${profileBarJs}
(function() {
  var message = document.getElementById('message'), list = document.getElementById('keys'), empty = document.getElementById('empty');
  var created = document.getElementById('created-dialog'), secret = document.getElementById('new-key');
  var revokeDialog = document.getElementById('revoke-dialog'), revokeTarget;
  function status(text, error) { message.textContent = text; message.classList.toggle('error', !!error); }
  async function api(path, options) {
    var response = await fetch('/keys/api' + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options));
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to update keys');
    return data;
  }
  async function load() {
    document.getElementById('refresh').disabled = true;
    try {
      var data = await api(''); list.replaceChildren();
      empty.hidden = data.keys.length > 0; empty.textContent = 'No client keys yet. Create one above.';
      data.keys.forEach(function(key) {
        var row = document.createElement('li'); row.className = 'key-row';
        var details = document.createElement('div'); details.className = 'key-detail';
        var name = document.createElement('div'); name.className = 'key-name'; name.textContent = key.name;
        var meta = document.createElement('div'); meta.className = 'key-meta';
        meta.textContent = 'Created ' + new Date(key.createdAt).toLocaleString() + (key.revokedAt ? ' · Revoked ' + new Date(key.revokedAt).toLocaleString() : '');
        details.append(name, meta);
        var badge = document.createElement('span'); badge.className = 'status' + (key.revokedAt ? ' revoked' : ''); badge.textContent = key.revokedAt ? 'Revoked' : 'Active';
        row.append(details, badge);
        if (!key.revokedAt) {
          var button = document.createElement('button'); button.className = 'danger'; button.textContent = 'Revoke'; button.setAttribute('aria-label', 'Revoke ' + key.name);
          button.addEventListener('click', function() { revokeTarget = key; document.getElementById('revoke-description').textContent = key.name + ' will stop accepting new API requests.'; revokeDialog.showModal(); }); row.append(button);
        }
        list.append(row);
      });
    } catch (error) { status(error.message, true); empty.textContent = 'Unable to load keys. Try Refresh.'; }
    finally { document.getElementById('refresh').disabled = false; }
  }
  document.getElementById('create-form').addEventListener('submit', async function(event) {
    event.preventDefault(); var button = document.getElementById('create-button'); button.disabled = true; status('Creating key…');
    try {
      var data = await api('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('key-name').value.trim() }) });
      secret.value = data.key; document.getElementById('copy-message').textContent = ''; created.showModal(); document.getElementById('copy-key').focus();
      document.getElementById('create-form').reset(); status('Key created. Copy it before closing this dialog.'); await load();
    } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  });
  created.addEventListener('close', function() { secret.value = ''; });
  window.addEventListener('pagehide', function() { secret.value = ''; });
  document.getElementById('close-dialog').addEventListener('click', function() { created.close(); });
  document.getElementById('copy-key').addEventListener('click', async function() {
    try { await navigator.clipboard.writeText(secret.value); document.getElementById('copy-message').textContent = 'Copied.'; }
    catch { secret.focus(); secret.select(); document.getElementById('copy-message').textContent = 'Select and copy the key manually.'; }
  });
  document.getElementById('cancel-revoke').addEventListener('click', function() { revokeDialog.close(); });
  document.getElementById('confirm-revoke').addEventListener('click', async function() {
    var button = document.getElementById('confirm-revoke'); button.disabled = true;
    try { await api('/' + encodeURIComponent(revokeTarget.id), { method: 'DELETE' }); revokeDialog.close(); status('Key revoked.'); await load(); }
    catch (error) { revokeDialog.close(); status(error.message, true); }
    finally { button.disabled = false; }
  });
  document.getElementById('refresh').addEventListener('click', load); load();
})();
</script></body></html>`
