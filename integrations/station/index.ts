// Edge function `station` (workstation project): 交給站長 without GitHub.
//  - dispatch (signed-in owner/editor): wakes the cloud Claude task 站長 through its API trigger, with the bug as payload,
//    and marks the item 處理中 with a link to the Claude session.
//  - report (the 站長 session itself): writes progress and the final report back onto the item. Each hand-off gets its
//    own random key; only its SHA-256 is stored on the item, so a key can only ever update that one item.
//  - config (signed-in owner): saves the task id and API token into private.station_config (unreadable from the website).
// Deployed with verify_jwt off because 站長 calls `report` without a Supabase login; dispatch/config check the login here.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const sb = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const REPORT_URL = `${URL_}/functions/v1/station`;
// Same table as STATION_REPO in index.html; a product doc can name its own `repo`.
const STATION_REPO: Record<string, string> = { 'meow-work': 'sonia6891/meow-work-app', remindcat: 'sonia6891/RemindCat' };
const BUSY = ['queued', 'working'];
const HOUR = 3_600_000;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (t: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
const cut = (t: unknown, n: number) => { const s = typeof t === 'string' ? t : ''; return s.length > n ? s.slice(0, n) + '…' : s; };

async function caller(req: Request) {
  const anon = createClient(URL_, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false },
  });
  const { data: { user } } = await anon.auth.getUser();
  const email = (user?.email ?? '').toLowerCase();
  if (!email) return { email: '', role: '' };
  const { data } = await sb.from('members').select('role').eq('email', email).maybeSingle();
  return { email, role: (data?.role as string) || '' };
}

async function loadIssue(id: string) {
  const { data } = await sb.from('docs').select('data,updated_at').match({ collection: 'issues', id }).maybeSingle();
  return data;
}
async function saveIssue(id: string, data: Record<string, unknown>, by: string) {
  const { error } = await sb.from('docs').update({ data, updated_at: new Date().toISOString(), updated_by: by }).match({ collection: 'issues', id });
  if (error) throw error;
}

async function dispatch(req: Request, body: Record<string, any>) {
  const who = await caller(req);
  if (!who.email) return json({ error: 'not_signed_in' }, 401);
  if (!['owner', 'editor'].includes(who.role)) return json({ error: 'no_permission' }, 403);
  const id = String(body.id || '');
  const row = await loadIssue(id);
  if (!row) return json({ error: 'not_found' }, 404);
  const it = row.data as Record<string, any>;
  const { data: product } = await sb.from('docs').select('data').match({ collection: 'products', id: it.product }).maybeSingle();
  const repo = (product?.data?.repo as string) || STATION_REPO[it.product] || '';
  if (!repo) return json({ error: 'no_repo' }, 400);

  // One 站長 per item at a time: pressing again while it is still on it just points at the same session.
  const st = it.station || {};
  if (st.mode === 'direct' && BUSY.includes(st.stage) && Date.now() - (st.at || 0) < 3 * HOUR && !body.again)
    return json({ ok: true, existing: true, url: st.url || '' });

  const { data: cfgRows, error: cfgErr } = await sb.rpc('station_config_get');
  const cfg = Array.isArray(cfgRows) ? cfgRows[0] : null;
  if (cfgErr || !cfg?.routine_id || !cfg?.token) return json({ error: 'not_configured' }, 400);

  const key = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const s = it.sentry;
  const payload = {
    workstation_id: id, repo, type: it.type, product: (product?.data?.name as string) || it.product,
    title: cut(it.title, 300), priority: it.priority || '', platform: it.platform || '', version: it.version || '',
    desc: cut(it.desc, 4000),
    sentry: s ? {
      short: s.short || '', url: s.url || '', level: s.level || '', count: s.count || 0, users: s.users || 0,
      lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : '', culprit: s.culprit || '',
      message: cut(s.event?.message, 1000), release: s.event?.release || '', os: s.event?.os || '', device: s.event?.device || '',
      trace: (s.event?.trace || []).slice(0, 20), crumbs: (s.event?.crumbs || []).slice(-30),
    } : null,
    report: { url: REPORT_URL, key },
  };
  const r = await fetch(`https://api.anthropic.com/v1/claude_code/routines/${cfg.routine_id}/fire`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`, 'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01', 'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: JSON.stringify(payload) }),
  });
  if (!r.ok) {
    const code = r.status === 401 || r.status === 403 ? 'token_rejected' : r.status === 404 ? 'routine_missing'
      : r.status === 429 ? 'too_many' : r.status === 400 ? 'routine_paused' : `fire_${r.status}`;
    return json({ error: code, detail: cut(await r.text(), 300) }, 502);
  }
  const fired = await r.json();
  const fresh = (await loadIssue(id))?.data as Record<string, any> || it;
  const station = { mode: 'direct', repo, at: Date.now(), stage: 'queued', session: fired.claude_code_session_id || '',
    url: fired.claude_code_session_url || '', keyHash: await sha256(key), by: who.email };
  await saveIssue(id, {
    ...fresh, station, owner: fresh.owner || '站長',
    status: fresh.type === 'bug' && (fresh.status === 'new' || fresh.status === 'doing') ? 'doing' : fresh.status,
    updatedAt: Date.now(),
  }, 'station');
  return json({ ok: true, url: station.url });
}

async function report(body: Record<string, any>) {
  const id = String(body.id || ''), key = String(body.key || '');
  if (!id || key.length !== 64) return json({ error: 'bad_request' }, 400);
  const row = await loadIssue(id);
  const it = row?.data as Record<string, any> | undefined;
  const st = it?.station;
  if (!it || st?.mode !== 'direct' || !st.keyHash || st.keyHash !== await sha256(key)) return json({ error: 'bad_key' }, 403);
  const stage = String(body.stage || '');
  if (!['working', 'reported', 'failed'].includes(stage)) return json({ error: 'bad_stage' }, 400);
  const next: Record<string, any> = { ...st, stage, reportedAt: Date.now() };
  if (typeof body.summary === 'string' && body.summary.trim()) next.summary = cut(body.summary.trim(), 6000);
  const n = (v: unknown) => Math.max(0, Math.min(99, Math.floor(Number(v) || 0)));
  if (body.total != null) { next.total = n(body.total); next.done = Math.min(n(body.done), next.total); }
  if (typeof body.branch === 'string' && /^claude\/[\w.\-\/]{1,120}$/.test(body.branch)) {
    next.branch = body.branch;
    next.prCreate = `https://github.com/${st.repo}/compare/${encodeURIComponent(body.branch).replace(/%2F/g, '/')}?expand=1`;
  }
  // A bug follows 站長: working → 處理中, failed → back to 待處理, done without a branch (the fix is already on main)
  // → 待驗證; with a branch it stays 處理中 until station-sync sees the PR merged. sentry-sync then marks it 已解決 once a
  // newer App Store version is out and the error hasn't come back. 待驗證／已解決／不處理 that the owner set are left alone.
  let status = it.status;
  if (it.type === 'bug' && (status === 'new' || status === 'doing'))
    status = stage === 'failed' ? 'new' : stage === 'reported' && !next.branch ? 'verify' : 'doing';
  await saveIssue(id, { ...it, station: next, status, updatedAt: Date.now() }, 'station');
  return json({ ok: true });
}

async function config(req: Request, body: Record<string, any>) {
  const who = await caller(req);
  if (who.role !== 'owner') return json({ error: 'not_owner' }, 403);
  const routine = String(body.routine || '').trim(), token = String(body.token || '').trim();
  if (!/^trig_\w{10,}$/.test(routine)) return json({ error: 'bad_routine' }, 400);
  if (!/^sk-ant-\S{20,}$/.test(token)) return json({ error: 'bad_token' }, 400);
  const { error } = await sb.rpc('station_config_set', { p_routine: routine, p_token: token, p_by: who.email });
  if (error) throw error;
  // What the website may show: that it is set, by whom and when. Never the token.
  await sb.from('docs').upsert({ collection: 'cfg', id: 'station-fire', updated_at: new Date().toISOString(), updated_by: 'station',
    data: { configured: true, routine, at: Date.now(), by: who.email, tokenHint: token.slice(-4) } });
  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action === 'report') return await report(body);
    if (body.action === 'dispatch') return await dispatch(req, body);
    if (body.action === 'config') return await config(req, body);
    return json({ error: 'bad_action' }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
