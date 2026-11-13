// Edge function `alerts` (workstation project): 每日日報與異常通知, pushed to the owner's LINE through the same
// LINE bot as 串文雷達 (secret LINE_CHANNEL_ACCESS_TOKEN; recipient threads_config.line_user_id, else secret LINE_USER_ID).
// Called every 15 minutes by pg_cron (integrations/alerts.sql) with the header x-alerts-secret = threads_config.cron_secret.
//  - 日報: once a day after 09:00 Taipei, yesterday per product (downloads, new subscriptions, revenue, ad spend,
//    cancellations, open bugs) next to the 7 days before it, with ⚠ lines when something fell or jumped a lot.
//  - 異常 (08:00–23:00 Taipei; found at night they wait for the morning): a new P0 bug or one that came back, today's
//    ad spend already over twice the usual day, and a sync that stopped (App numbers, Sentry, Meta ads).
// Every alert is sent once (cfg/alerts remembers what went out, never the token). Several found together go out as
// one message: the LINE free plan allows 200 pushes a month, shared with 串文雷達.
// ?dry=1 returns the messages without sending them.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const SITE = 'https://sonia6891.github.io/product-workstation/';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const HOUR = 3_600_000, DAY = 86_400_000;

const tpe = (t = Date.now()) => new Date(t + 8 * HOUR); // read with getUTC* = Asia/Taipei wall clock
const dayOf = (t = Date.now()) => tpe(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const WEEK = '日一二三四五六';
const dayLabel = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}（${WEEK[new Date(d + 'T00:00:00Z').getUTCDay()]}）`;
const adSum = (a: unknown) => a && typeof a === 'object' ? Object.values(a as Record<string, unknown>).reduce((s: number, v) => s + (Number(v) || 0), 0) : Number(a) || 0;

async function linePush(text: string) {
  const token = (Deno.env.get('LINE_CHANNEL_ACCESS_TOKEN') || '').trim();
  if (!token) throw new Error('no_line_token');
  const { data } = await sb.from('threads_config').select('value').eq('key', 'line_user_id').maybeSingle();
  const ok = (s: string) => /^U[0-9a-f]{32}$/.test(s);
  const to = [String(data?.value || '').trim(), (Deno.env.get('LINE_USER_ID') || '').trim()].find(ok);
  if (!to) throw new Error('no_line_user');
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Line-Retry-Key': crypto.randomUUID() },
    body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!r.ok) throw new Error(`line_${r.status}`);
}

type Cell = { dl: number; sub: number; rev: number; ad: number };
const blank = (): Cell => ({ dl: 0, sub: 0, rev: 0, ad: 0 });

async function gather(today: string) {
  const from = addDays(today, -8);
  const [{ data: rows }, { data: docs }, { data: subEv }] = await Promise.all([
    sb.from('daily_metrics').select('product_id,date,downloads,new_subs,revenue,ad_spend').gte('date', from).lte('date', today).or('sample.is.null,sample.eq.false'),
    sb.from('docs').select('collection,id,data').in('collection', ['products', 'issues', 'cfg']),
    sb.from('sub_events').select('product_id,kind,event_at').gte('event_at', new Date(Date.parse(from + 'T00:00:00+08:00')).toISOString()),
  ]);
  const products = (docs || []).filter(d => d.collection === 'products' && !d.data?.sample)
    .sort((a, b) => (a.data?.createdAt || 0) - (b.data?.createdAt || 0)).map(d => ({ id: d.id as string, name: String(d.data?.name || d.id) }));
  const cfg = Object.fromEntries((docs || []).filter(d => d.collection === 'cfg').map(d => [d.id, d.data]));
  const bugs = (docs || []).filter(d => d.collection === 'issues' && d.data?.type === 'bug' && !['done', 'wont'].includes(d.data?.status)).map(d => ({ id: d.id as string, ...d.data }));
  const by = new Map<string, Cell>(); // product|date
  for (const r of rows || []) {
    const k = `${r.product_id}|${r.date}`, c = by.get(k) || blank();
    c.dl += Number(r.downloads) || 0; c.sub += Number(r.new_subs) || 0; c.rev += Number(r.revenue) || 0; c.ad += adSum(r.ad_spend);
    by.set(k, c);
  }
  const cell = (p: string, d: string) => by.get(`${p}|${d}`) || blank();
  const cancels = (p: string, d: string) => (subEv || []).filter(e => e.product_id === p && e.kind === 'cancel' && dayOf(Date.parse(e.event_at)) === d).length;
  return { products, cfg, bugs, cell, cancels, currency: String(cfg.main?.currency || 'TWD') };
}

function money(v: number, cur: string) {
  const n = Math.round(v).toLocaleString('en-US');
  return cur === 'TWD' ? `NT$${n}` : `${cur} ${n}`;
}
const pct = (now: number, avg: number) => avg ? `${now >= avg ? '▲' : '▼'}${Math.abs(Math.round((now - avg) / avg * 100))}%` : '';

function dailyText(g: Awaited<ReturnType<typeof gather>>, day: string) {
  const lines = [`📊 產品工作站日報 ${dayLabel(day)}`];
  const prev = Array.from({ length: 7 }, (_, i) => addDays(day, -(i + 1)));
  for (const p of g.products) {
    const c = g.cell(p.id, day);
    const avg = prev.map(d => g.cell(p.id, d)).reduce((a, x) => ({ dl: a.dl + x.dl / 7, sub: a.sub + x.sub / 7, rev: a.rev + x.rev / 7, ad: a.ad + x.ad / 7 }), blank());
    const open = g.bugs.filter(b => b.product === p.id), p0 = open.filter(b => b.priority === 'P0').length;
    const cancel = g.cancels(p.id, day);
    if (!c.dl && !c.sub && !c.rev && !c.ad && !open.length && !cancel && !avg.dl) continue;
    lines.push('', `【${p.name}】`);
    lines.push(`下載 ${c.dl.toLocaleString('en-US')}${avg.dl >= 1 ? `（前 7 天平均 ${Math.round(avg.dl)}，${pct(c.dl, avg.dl)}）` : ''}`);
    if (c.sub || c.rev || avg.sub >= 0.5) lines.push(`新訂閱 ${c.sub}・營收 ${money(c.rev, g.currency)}${avg.rev >= 1 ? `（${pct(c.rev, avg.rev)}）` : ''}`);
    if (c.ad || avg.ad) lines.push(`廣告費 ${money(c.ad, g.currency)}${c.ad ? `・營收÷廣告費 ${(c.rev / c.ad).toFixed(2)}x` : ''}${c.ad && c.sub ? `・每個新付費用戶 ${money(c.ad / c.sub, g.currency)}` : ''}`);
    const extra = [cancel ? `關閉續訂 ${cancel}` : '', open.length ? `未結案 Bug ${open.length}${p0 ? `（P0 ${p0}）` : ''}` : ''].filter(Boolean).join('・');
    if (extra) lines.push(extra);
    if (avg.dl >= 20 && c.dl < avg.dl * 0.5) lines.push('⚠ 下載不到前 7 天平均的一半');
    if (avg.sub >= 2 && c.sub === 0) lines.push('⚠ 一整天沒有新訂閱');
    if (avg.rev > 0 && avg.sub >= 2 && c.rev < avg.rev * 0.3) lines.push('⚠ 營收不到前 7 天平均的三成');
    if (avg.ad >= 100 && c.ad > avg.ad * 2) lines.push('⚠ 廣告費是前 7 天平均的兩倍以上');
    if (c.ad >= 300 && c.dl < c.ad / 30) lines.push('⚠ 廣告有花但下載很少，看一下廣告');
  }
  lines.push('', SITE);
  return lines.join('\n');
}

function liveAlerts(g: Awaited<ReturnType<typeof gather>>, today: string, sent: Record<string, number>) {
  const out: { key: string; text: string }[] = [];
  const name = (id: string) => g.products.find(p => p.id === id)?.name || id;
  for (const b of g.bugs) {
    if (b.priority === 'P0' && b.status === 'new' && Date.now() - (b.createdAt || 0) < 2 * DAY)
      out.push({ key: `bug-${b.id}`, text: `🐞 新的 P0 Bug（${name(b.product)}）：${String(b.title).slice(0, 120)}${b.sentry ? `，${b.sentry.users || 0} 人遇到` : ''}` });
    if (b.reopened?.at && Date.now() - b.reopened.at < 2 * DAY)
      out.push({ key: `reopen-${b.id}-${b.reopened.at}`, text: `🔁 修好的 Bug 又發生了（${name(b.product)}）：${String(b.title).slice(0, 120)}` });
  }
  const prev = Array.from({ length: 7 }, (_, i) => addDays(today, -(i + 1)));
  for (const p of g.products) {
    const avg = prev.reduce((a, d) => a + g.cell(p.id, d).ad / 7, 0), now = g.cell(p.id, today).ad;
    if (avg >= 100 && now > avg * 2) out.push({ key: `adspike-${p.id}-${today}`, text: `💸 ${p.name} 今天廣告費已經 ${money(now, g.currency)}，是平常一天（${money(avg, g.currency)}）的兩倍以上` });
  }
  // Syncs that stopped. App numbers push every minute; Sentry runs every 2 minutes, Meta hourly.
  const syncs = Object.entries((g.cfg.sync?.sources || {}) as Record<string, { at: number }>).map(([k, v]) => [`App 數字（${name(k)}）`, v.at, 30 * 60_000] as const);
  const checks: (readonly [string, number, number, boolean?])[] = [...syncs,
    ['Sentry 錯誤同步', g.cfg.sentry?.ok ? g.cfg.sentry.at : 0, 2 * HOUR, !!g.cfg.sentry],
    ['Meta 廣告費同步', g.cfg['meta-ads']?.ok ? g.cfg['meta-ads'].at : 0, 3 * HOUR, !!g.cfg['meta-ads']]];
  for (const [label, at, limit, exists = true] of checks) {
    if (!exists) continue;
    const lastOk = Number(at) || 0;
    if (Date.now() - lastOk > limit) out.push({ key: `stale-${label}-${today}`, text: `⚙️ ${label}${lastOk ? `從 ${new Date(lastOk + 8 * HOUR).toISOString().slice(5, 16).replace('T', ' ').replace('-', '/')} 之後` : ''}沒有成功更新，數字可能不是最新` });
  }
  return out.filter(a => !sent[a.key]);
}

Deno.serve(async (req: Request) => {
  const { data: sec } = await sb.from('threads_config').select('value').eq('key', 'cron_secret').maybeSingle();
  if (!sec?.value || req.headers.get('x-alerts-secret') !== sec.value) return json({ error: 'unauthorized' }, 401);
  const dry = new URL(req.url).searchParams.get('dry') === '1';
  const { data: prevDoc } = await sb.from('docs').select('data').match({ collection: 'cfg', id: 'alerts' }).maybeSingle();
  const st = (prevDoc?.data || {}) as Record<string, any>;
  const sent: Record<string, number> = Object.fromEntries(Object.entries(st.sent || {}).filter(([, t]) => Date.now() - Number(t) < 30 * DAY)) as Record<string, number>;
  const now = tpe(), hour = now.getUTCHours(), today = dayOf(), yesterday = addDays(today, -1);
  const out: Record<string, unknown> = { at: Date.now(), ok: true };
  try {
    const g = await gather(today);
    const msgs: { text: string; keys: string[]; daily?: boolean }[] = [];
    if ((dry || (hour >= 9 && st.lastDaily !== yesterday))) msgs.push({ text: dailyText(g, yesterday), keys: [], daily: true });
    const live = liveAlerts(g, today, sent);
    if (live.length && (dry || (hour >= 8 && hour < 23))) msgs.push({ text: live.map(a => a.text).join('\n') + `\n${SITE}`, keys: live.map(a => a.key) });
    if (dry) return json({ dry: true, messages: msgs.map(m => m.text) });
    for (const m of msgs) {
      await linePush(m.text);
      m.keys.forEach(k => sent[k] = Date.now());
      if (m.daily) st.lastDaily = yesterday;
    }
    out.sent = msgs.length;
    out.log = [...msgs.map(m => ({ at: Date.now(), text: m.text.slice(0, 300) })), ...(st.log || [])].slice(0, 10);
  } catch (e) {
    out.ok = false; out.error = String((e as Error)?.message || e);
    out.log = st.log || [];
  }
  // Saved only when something went out or the outcome changed, so the 15-minute runs don't keep rewriting it.
  if (out.sent || out.ok !== st.ok || out.error !== st.error)
    await sb.from('docs').upsert({ collection: 'cfg', id: 'alerts', updated_at: new Date().toISOString(), updated_by: 'alerts',
      data: { ...out, lastDaily: st.lastDaily || null, sent } });
  return json(out);
});
