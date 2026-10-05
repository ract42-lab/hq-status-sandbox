// HQ deterministic monitor (spec 5.3). Runs only in the public hq-status repository. No LLM, no secrets beyond GITHUB_TOKEN.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
export const STALE_MS = 6 * 3600000;
export const ALERT_TITLE = 'alerta:caído';
export function heartbeatAge(text, now) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z\n$/.test(text)) return { valid: false, ageMs: Infinity };
  const at = Date.parse(text.trim());
  return Number.isFinite(at) ? { valid: true, at, ageMs: now - at } : { valid: false, ageMs: Infinity };
}
export function decide({ heartbeatText, now, openAlerts }) {
  const age = heartbeatAge(heartbeatText, now);
  if (age.valid && age.ageMs <= STALE_MS) return { action: 'none', age };
  return { action: openAlerts > 0 ? 'already_open' : 'open', age };
}
// api.github.com answers rel="next" with /repositories/<id>/issues?...&after=<cursor> (not /repos/<owner>/<repo>/...).
// Follow only that origin and an issues-listing path; anything else means alert uniqueness cannot be verified.
function nextPageUrl(next, api, repo) {
  let u = null;
  try { u = new URL(next); } catch { /* rejected below */ }
  const ok = u && u.origin === new URL(api).origin && (u.pathname === '/repos/' + repo + '/issues' || /^\/repositories\/\d+\/issues$/.test(u.pathname));
  if (!ok) throw new Error('Unexpected pagination link; cannot verify alert uniqueness');
  return u.href;
}
export async function runMonitor({ env = process.env, fetchImpl = fetch, readFile = readFileSync, now = Date.now() } = {}) {
  const repo = env.GITHUB_REPOSITORY, token = env.GITHUB_TOKEN, api = env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo ?? '') || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN required');
  let heartbeatText = null;
  try { heartbeatText = readFile(join(env.GITHUB_WORKSPACE ?? '.', 'heartbeat.txt'), 'utf8'); } catch { heartbeatText = null; }
  const headers = { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token, 'x-github-api-version': '2026-03-10', 'user-agent': 'hq-monitor' };
  // Paginate every open issue: an open alert beyond the first page must still suppress a duplicate.
  let openAlerts = 0, url = api + '/repos/' + repo + '/issues?state=open&per_page=100';
  for (let page = 1; url; page++) {
    if (page > 20) throw new Error('Too many open issues to verify alert uniqueness');
    const list = await fetchImpl(url, { headers });
    if (list.status !== 200) throw new Error('List issues failed: HTTP ' + list.status);
    openAlerts += (await list.json()).filter(i => !i.pull_request && i.title === ALERT_TITLE && i.user?.login === 'github-actions[bot]').length;
    const next = /<([^>]+)>;\s*rel="next"/.exec(list.headers?.get?.('link') ?? '')?.[1];
    url = next ? nextPageUrl(next, api, repo) : null;
  }
  const decision = decide({ heartbeatText, now, openAlerts });
  if (decision.action === 'open') {
    const last = decision.age.valid ? new Date(decision.age.at).toISOString() : 'ausente o invalido';
    const runId = /^\d+$/.test(env.GITHUB_RUN_ID ?? '') ? env.GITHUB_RUN_ID : 'local';
    const event = /^[a-z_]+$/.test(env.GITHUB_EVENT_NAME ?? '') ? env.GITHUB_EVENT_NAME : 'local';
    // T11 binds the alert to the run that opened it: hq-monitor-run:<run id>:<event>.
    const body = 'El heartbeat de HQ supera el umbral de 6 h.\n\nUltimo heartbeat: ' + last + '\nComprobado: ' + new Date(now).toISOString() +
      '\n\nGenerado por hq-monitor (determinista, sin LLM). Cerrar a mano cuando el supervisor vuelva.\nhq-monitor-run:' + runId + ':' + event;
    const created = await fetchImpl(api + '/repos/' + repo + '/issues', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: ALERT_TITLE, body }) });
    if (created.status !== 201) throw new Error('Create alert failed: HTTP ' + created.status);
  }
  return decision;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMonitor().then(d => {
    process.stdout.write(JSON.stringify({ action: d.action, ageHours: Number.isFinite(d.age.ageMs) ? Math.round(d.age.ageMs / 360000) / 10 : null }) + '\n');
  }, error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
