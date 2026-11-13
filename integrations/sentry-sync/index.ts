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

// Where the latest event got stuck, so a fix can start from the code (the workstation shows it, and 交給站長 sends it):
// the innermost frames of the exception, else of the crashed or main thread. ★ marks the app's own code.
// Fetched only for a new issue or one that happened again, so a run costs at most a few extra calls.
const TRACE_LIMIT = 10;
async function latestTrace(s: typeof SOURCES[number], issueId: string, token: string) {
  const r = await fetch(`https://${s.host}/api/0/organizations/${s.org}/issues/${issueId}/events/latest/`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const ev = await r.json();
  const entries: any[] = ev.entries || [];
  const exc = entries.find(e => e.type === 'exception')?.data?.values || [];
  const threads = entries.find(e => e.type === 'threads')?.data?.values || [];
  const stack = [...exc].reverse().find((v: any) => v.stacktrace?.frames?.length)?.stacktrace
    || threads.find((t: any) => t.crashed && t.stacktrace?.frames?.length)?.stacktrace
    || threads.find((t: any) => t.current && t.stacktrace?.frames?.length)?.stacktrace
    || threads.find((t: any) => t.stacktrace?.frames?.length)?.stacktrace;
  const base = (x: string) => String(x || '').split(/[\\/]/).pop();
  const frames = [...(stack?.frames || [])].reverse().slice(0, 40).map((f: any) => {
    const where = f.filename || f.absPath ? `${base(f.filename || f.absPath)}${f.lineNo ? ':' + f.lineNo : ''}${f.colNo ? ':' + f.colNo : ''}` : '';
    return `${f.inApp ? '★ ' : ''}${base(f.package) ? base(f.package) + ' ' : ''}${f.function || f.instructionAddr || '?'}${where ? ' (' + where + ')' : ''}`.slice(0, 200);
  });
  const tag = (k: string) => (ev.tags || []).find((t: any) => t.key === k)?.value || '';
  // What happened just before (page changes, requests, the App going to the background): the last 12, oldest first.
  const crumbs = (entries.find(e => e.type === 'breadcrumbs')?.data?.values || []).slice(-12).map((b: any) => {
    const d = b.data || {}, what = b.message || d.state || [d.method, d.url, d.status_code].filter(Boolean).join(' ') || d.to || '';
    return `${String(b.timestamp || '').slice(11, 19)} ${b.category || b.type || ''} ${what}`.trim().slice(0, 160);
  });
  return { at: Date.parse(ev.dateCreated) || Date.now(), trace: frames, crumbs, release: tag('release'), os: tag('os'), device: tag('device'),
    message: String(exc[exc.length - 1]?.value || ev.message || '').slice(0, 500) };
}

// The version now on the App Store (Apple's public lookup, no key). The hourly `_` gets past Apple's CDN cache.
async function appStore(iosId: string) {
  const r = await fetch(`https://itunes.apple.com/lookup?id=${iosId}&country=tw&_=${Math.floor(Date.now() / 3_600_000)}`);
  const a = r.ok ? (await r.json().catch(() => ({})))?.results?.[0] : null;
  const at = Date.parse(a?.currentVersionReleaseDate);
  return a?.version && at ? { version: String(a.version), at } : null;
}
const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] || 0) !== (y[k] || 0)) return (x[k] || 0) > (y[k] || 0);
  return false;
};
// Fixed and shipped → 已解決: 站長 fixed it (done with the fix already on main, or its PR merged), the App Store now has
// a newer version than the one the error last came from, and it hasn't happened since that version went live.
// Coming back afterwards puts it back to 待處理 (regressed, below).
function shipped(old: Record<string, any>, sentry: Record<string, any>, store: { version: string; at: number } | null) {
  const st = old.station || {};
  if (!store || old.type !== 'bug' || !['new', 'doing', 'verify'].includes(old.status)) return false;
  if (!(st.stage === 'merged' || (st.stage === 'reported' && !st.branch))) return false;
  const v = String(sentry.event?.release || '').split('@').pop()!.split('+')[0]; // meow-work@3.0+336 → 3.0
  return /^\d+(\.\d+)*$/.test(v) && newer(store.version, v) && sentry.lastSeen < store.at;
}

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
  const { data: prods } = await sb.from('docs').select('id,data').eq('collection', 'products');
  const iosOf = new Map((prods || []).map(p => [p.id, String(p.data?.ios || '').replace(/\D/g, '')]));
  for (const s of token ? SOURCES : []) {
    try {
      const ios = iosOf.get(s.product);
      let store: Awaited<ReturnType<typeof appStore>> | undefined; // looked up only when a 站長-fixed bug needs it
      const storeNow = async () => store !== undefined ? store : (store = ios ? await appStore(ios).catch(() => null) : null);
      const url = `https://${s.host}/api/0/organizations/${s.org}/issues/?project=${s.projectId}&query=is:unresolved&statsPeriod=90d&sort=date&limit=100`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'token_rejected' : `sentry_${r.status}`);
      const issues = await r.json();
      const { data: existing, error } = await sb.from('docs').select('id,data').eq('collection', 'issues').like('id', `sentry-${s.product}-%`);
      if (error) throw error;
      const ex = new Map((existing || []).map(d => [d.id, d.data]));
      const seen = new Set<string>(), rows = [];
      let traced = 0;
      for (const i of issues) {
        const id = `sentry-${s.product}-${i.id}`; seen.add(id);
        const old = ex.get(id);
        const sentry: Record<string, any> = { id: i.id, short: i.shortId, url: i.permalink, level: i.level, count: Number(i.count) || 0, users: i.userCount || 0,
          firstSeen: Date.parse(i.firstSeen), lastSeen: Date.parse(i.lastSeen), culprit: i.culprit || '' };
        // The latest event's stack: kept from before unless the issue happened again since it was read.
        const prevEvent = old?.sentry?.event;
        if (prevEvent && prevEvent.seen === sentry.lastSeen && prevEvent.crumbs) sentry.event = prevEvent;
        else if (traced < TRACE_LIMIT) {
          traced++;
          const e = await latestTrace(s, i.id, token!).catch(() => null);
          if (e) sentry.event = { ...e, seen: sentry.lastSeen };
          else if (prevEvent) sentry.event = prevEvent;
        } else if (prevEvent) sentry.event = prevEvent;
        if (!old) {
          rows.push(row(id, { type: 'bug', title: i.title, product: s.product, priority: priority(i), status: 'new', platform: '', version: '', owner: '',
            desc: `${sentry.culprit}\n\n來源：Sentry ${sentry.short}`.trim(), createdAt: sentry.firstSeen, updatedAt: sentry.lastSeen, sentry }));
          continue;
        }
        // Marked solved here (by hand or by `shipped`) but it happened again afterwards → back to 待處理. 不處理 stays as the owner set it.
        const regressed = old.status === 'done' && sentry.lastSeen > (old.updatedAt || 0);
        const fixed = !regressed && ['new', 'doing', 'verify'].includes(old.status) && ['merged', 'reported'].includes(old.station?.stage)
          && shipped(old, sentry, await storeNow());
        if (!regressed && !fixed && JSON.stringify(old.sentry) === JSON.stringify(sentry) && old.title === i.title) continue;
        const next: Record<string, any> = { ...old, title: i.title, sentry, status: regressed ? 'new' : fixed ? 'done' : old.status,
          updatedAt: regressed || fixed ? Date.now() : Math.max(old.updatedAt || 0, sentry.lastSeen) };
        if (fixed) next.autoSolved = { version: store!.version, at: Date.now() };
        if (regressed) delete next.autoSolved;
        rows.push(row(id, next));
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
