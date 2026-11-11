// Edge function `sentry-sync` (workstation project). Pulls each app's unresolved Sentry issues into
// the Bug 追蹤 page (docs collection 'issues', id sentry-<product>-<issue id>). Called every 2 minutes by pg_cron.
// Needs the secret SENTRY_AUTH_TOKEN (read-only: org:read, project:read, event:read). Status goes to cfg/sentry.
// No caller auth on purpose: it only reads Sentry and refreshes these rows, and runs at most once every 50 s.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SOURCES = [
  { product: 'meow-work', org: 'sole-proprietorship-jo', projectId: '4512394101325824', host: 'us.sentry.io' }, // meow-work-app
  { product: 'remindcat', org: 'sole-proprietorship-jo', projectId: '4512394069540864', host: 'us.sentry.io' },
];
const isOpen = (s: string) => s !== 'done' && s !== 'wont';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });
const row = (id: string, data: unknown, collection = 'issues') =>
  ({ collection, id, data, updated_at: new Date().toISOString(), updated_by: 'sentry' });

function priority(i: { level: string; userCount: number }) {
  if (i.level === 'fatal') return 'P0';
  if (i.level === 'error') return i.userCount >= 20 ? 'P1' : 'P2';
  return 'P3';
}

Deno.serve(async () => {
  const { data: prev } = await sb.from('docs').select('data').match({ collection: 'cfg', id: 'sentry' }).maybeSingle();
  if (prev?.data?.ok && Date.now() - prev.data.at < 50_000) return json({ skipped: true });
  const token = Deno.env.get('SENTRY_AUTH_TOKEN');
  const status: Record<string, unknown> = { at: Date.now(), ok: !!token, sources: {} };
  if (!token) status.error = 'no_token';
  for (const s of token ? SOURCES : []) {
    try {
      const url = `https://${s.host}/api/0/organizations/${s.org}/issues/?project=${s.projectId}&query=is:unresolved&statsPeriod=90d&sort=date&limit=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'token_rejected' : `sentry_${r.status}`);
      const issues = await r.json();
      const { data: existing, error } = await sb.from('docs').select('id,data').eq('collection', 'issues').like('id', `sentry-${s.product}-%`);
      if (error) throw error;
      const ex = new Map((existing || []).map(d => [d.id, d.data]));
      const seen = new Set<string>(), rows = [];
      for (const i of issues) {
        const id = `sentry-${s.product}-${i.id}`; seen.add(id);
        const old = ex.get(id);
        const sentry = { id: i.id, short: i.shortId, url: i.permalink, level: i.level, count: Number(i.count) || 0, users: i.userCount || 0,
          firstSeen: Date.parse(i.firstSeen), lastSeen: Date.parse(i.lastSeen), culprit: i.culprit || '' };
        if (!old) {
          rows.push(row(id, { type: 'bug', title: i.title, product: s.product, priority: priority(i), status: 'new', platform: '', version: '', owner: '',
            desc: `${sentry.culprit}\n\n來源：Sentry ${sentry.short}`.trim(), createdAt: sentry.firstSeen, updatedAt: sentry.lastSeen, sentry }));
          continue;
        }
        // Marked solved here but it happened again afterwards → back to 待處理. 不處理 stays as the owner set it.
        const regressed = old.status === 'done' && sentry.lastSeen > (old.updatedAt || 0);
        if (!regressed && JSON.stringify(old.sentry) === JSON.stringify(sentry) && old.title === i.title) continue;
        rows.push(row(id, { ...old, title: i.title, sentry, status: regressed ? 'new' : old.status,
          updatedAt: regressed ? Date.now() : Math.max(old.updatedAt || 0, sentry.lastSeen) }));
      }
      // Resolved (or quiet for 90 days) in Sentry → 已解決 here. Only when the list wasn't cut off at 100.
      if (issues.length < 100) for (const [id, d] of ex) if (!seen.has(id) && isOpen(d.status)) rows.push(row(id, { ...d, status: 'done', updatedAt: Date.now() }));
      if (rows.length) { const { error: e2 } = await sb.from('docs').upsert(rows); if (e2) throw e2; }
      (status.sources as Record<string, unknown>)[s.product] = { ok: true, open: issues.length, changed: rows.length };
    } catch (e) {
      status.ok = false;
      (status.sources as Record<string, unknown>)[s.product] = { ok: false, error: String((e as Error).message || e) };
    }
  }
  await sb.from('docs').upsert(row('sentry', status, 'cfg'));
  return json(status);
});
