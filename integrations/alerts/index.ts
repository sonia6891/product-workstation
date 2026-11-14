// Edge function `alerts` (workstation project): 每日日報與異常通知, pushed to the owner's LINE through the same
// LINE bot as 串文雷達 (secret LINE_CHANNEL_ACCESS_TOKEN; recipient threads_config.line_user_id, else secret LINE_USER_ID).
// Called every 15 minutes by pg_cron (integrations/alerts.sql) with the header x-alerts-secret = threads_config.cron_secret.
//  - 日報: once a day after 09:00 Taipei, yesterday per product (downloads, new subscriptions, revenue, ad spend,
//    cancellations, open bugs) next to the 7 days before it, with ⚠ lines when something fell or jumped a lot.
//  - 異常 (08:00–23:00 Taipei; found at night they wait for the morning): a new P0 bug or one that came back, today's
//    ad spend already over twice the usual day, and a sync that stopped (App numbers, Sentry, Meta ads).
//  - 週報: Monday after 09:00 Taipei, last week (Mon–Sun) next to the week before it.
//  - App Store 評論: Apple's public review feed, read hourly for every product with an App Store ID in every market of
//    設定 (kept as docs cfg/reviews, shown on 總覽). A new 1–2 star review goes out as an alert.
// Each goes out as a LINE card (same look as 喵管家's reports); plain text is the fallback and the altText.
// Every alert is sent once (cfg/alerts remembers what went out, never the token). Several found together go out as
// one message: the LINE free plan allows 200 pushes a month, shared with 串文雷達.
// ?dry=1 returns the messages (日報, 週報, alerts) and their cards without sending them (the hourly review check still
// runs). ?test=1 sends 日報 once more as a test (&only=weekly or &only=alerts for the others) and records nothing.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
// openExternalBrowser=1: LINE then opens the link in the phone's own browser (where the owner is signed in), not in
// LINE's built-in one, which has no saved sign-in and asks for the password every time.
const SITE = 'https://sonia6891.github.io/product-workstation/?openExternalBrowser=1';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
const HOUR = 3_600_000, DAY = 86_400_000;

const tpe = (t = Date.now()) => new Date(t + 8 * HOUR); // read with getUTC* = Asia/Taipei wall clock
const dayOf = (t = Date.now()) => tpe(t).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const WEEK = '日一二三四五六';
const dayLabel = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8)}（${WEEK[new Date(d + 'T00:00:00Z').getUTCDay()]}）`;
const adSum = (a: unknown) => a && typeof a === 'object' ? Object.values(a as Record<string, unknown>).reduce((s: number, v) => s + (Number(v) || 0), 0) : Number(a) || 0;

// Which LINE bot sends. The workstation's own official account when its token is set (secret WORKSTATION_LINE_TOKEN;
// the owner's user ID for it is threads_config.line_user_id_workstation, or the secret WORKSTATION_LINE_USER_ID: the
// account 產品工作站 has its own provider, and LINE user IDs are per provider). Until then, and whenever the own account refuses the push
// (not added as a friend yet, wrong ID), the bot shared with 串文雷達 sends, so a report is never lost.
let lineVia = '';
async function linePush(text: string, flex?: unknown) {
  const env = (k: string) => (Deno.env.get(k) || '').trim();
  const { data: ids } = await sb.from('threads_config').select('key,value').in('key', ['line_user_id', 'line_user_id_workstation']);
  const cfgId = (k: string) => String((ids || []).find(r => r.key === k)?.value || '').trim();
  const ok = (s: string) => /^U[0-9a-f]{32}$/.test(s);
  const shared = [cfgId('line_user_id'), env('LINE_USER_ID')].find(ok);
  const post = async (token: string, to: string, messages: unknown[]) => (await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Line-Retry-Key': crypto.randomUUID() },
    body: JSON.stringify({ to, messages }),
  })).status;
  // The card (same look as 喵管家's reports); the plain text is its altText and what goes out if LINE rejects the card.
  const send = async (token: string, to: string) => {
    const plain = [{ type: 'text', text: text.slice(0, 4900) }];
    if (!flex) return await post(token, to, plain);
    const s = await post(token, to, [{ type: 'flex', altText: text.slice(0, 380), contents: flex }]);
    return s === 400 ? await post(token, to, plain) : s;
  };
  const own = env('WORKSTATION_LINE_TOKEN'), ownTo = [env('WORKSTATION_LINE_USER_ID'), cfgId('line_user_id_workstation'), shared].find(s => s && ok(s));
  if (own && ownTo) {
    const s = await send(own, ownTo).catch(() => 0);
    if (s >= 200 && s < 300) { lineVia = 'workstation'; return; }
    lineVia = `shared (own account: ${s})`;
  } else lineVia = 'shared';
  const token = env('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) throw new Error('no_line_token');
  if (!shared) throw new Error('no_line_user');
  const s = await send(token, shared);
  if (s < 200 || s >= 300) throw new Error(`line_${s}`);
}

// ---------- 卡片 (LINE Flex) ----------
// The paper-and-leather card of 喵管家's hourly report (meow-work: public.meow_flex_dashboard), so every report in the
// owner's LINE looks alike: leather header, KPI tiles, then one paper card per section. A row of one cell is a line
// of text, two cells a label and its value, three or more a table row (the first table row of a card is its header).
type Row = string[];
type Section = { heading: string; color?: string; rows: Row[] };
type Kpi = { label: string; value: string; note: string; color: string };
type Card = { title: string; subtitle: string; kpis: Kpi[]; sections: Section[] };
const PALETTE = ['#2C5C8C', '#3B7536', '#C96614', '#6A3FA0', '#2C5E5A', '#8A5C3F', '#3C3F8F', '#B23A57'];
const TINT: Record<string, string> = { '#2C5C8C': '#DDE8F3', '#3B7536': '#E3ECD9', '#C96614': '#F7E3B8', '#2C5E5A': '#D9E9E6', '#6A3FA0': '#EFE4FA',
  '#8A5C3F': '#ECDFD1', '#A83D35': '#F6DCD6', '#3C3F8F': '#E3E4F6', '#B23A57': '#FBE3E8' };
const RED = '#A83D35';
const T = (text: string, o: Record<string, unknown> = {}) => ({ type: 'text', text: String(text || '—').slice(0, 300), ...o });
const stitch = (tone: string, margin: string) => ({ type: 'image', url: `https://ygrlvmyqrhyfkglomsbq.supabase.co/functions/v1/meow-stitch?c=${tone}`,
  size: 'full', aspectRatio: '100:1', aspectMode: 'cover', margin });
function cardRows(rows: Row[]) {
  const items: unknown[] = [];
  let tables = 0;
  for (const r of rows) {
    if (items.length) items.push({ type: 'separator', margin: 'sm', color: '#E6D8C0' });
    if (r.length <= 1) items.push(T(r[0], { size: 'xs', color: '#5B3A29', margin: 'sm', wrap: true }));
    else if (r.length === 2 && r[1].length > 18) items.push(T(r[0], { size: 'xs', color: '#7A5D4A', margin: 'sm' }), T(r[1], { size: 'xs', color: '#3B2417', wrap: true, margin: 'xs' }));
    else if (r.length === 2) items.push({ type: 'box', layout: 'horizontal', margin: 'sm', contents: [
      T(r[0], { size: 'xs', color: '#7A5D4A', flex: 3, wrap: true }), T(r[1], { size: 'xs', weight: 'bold', color: '#3B2417', flex: 4, align: 'end', wrap: true })] });
    else {
      const hdr = ++tables === 1;
      items.push({ type: 'box', layout: 'horizontal', margin: 'sm', contents: r.map((v, i) => T(v, { size: 'xxs', flex: i === 0 ? 2 : 1, align: i === 0 ? 'start' : 'end', wrap: true,
        color: hdr ? '#8A6A4F' : '#3B2417', weight: hdr || i === 0 ? 'regular' : 'bold' })) });
    }
  }
  return items.length ? items : [T('—', { size: 'xs', color: '#7A5D4A' })];
}
function flexCard(c: Card) {
  const tile = (k: Kpi) => ({ type: 'box', layout: 'vertical', flex: 1, backgroundColor: TINT[k.color] || '#EFE3CF', cornerRadius: '12px', borderWidth: '1px', borderColor: '#8A6A4F', paddingAll: '10px',
    contents: [T(k.label, { size: 'xs', color: '#5B3A29', weight: 'bold' }), T(k.value, { size: 'xl', weight: 'bold', color: k.color, margin: 'xs' }), T(k.note, { size: 'xxs', color: '#7A5D4A' })] });
  const kpiRows = [];
  for (let i = 0; i < c.kpis.length; i += 2) kpiRows.push({ type: 'box', layout: 'horizontal', margin: 'sm', spacing: 'sm',
    contents: [tile(c.kpis[i]), c.kpis[i + 1] ? tile(c.kpis[i + 1]) : { type: 'box', layout: 'vertical', flex: 1, contents: [{ type: 'filler' }] }] });
  const paper = (sec: Section, i: number) => ({ type: 'box', layout: 'vertical', margin: 'md', paddingAll: '12px', backgroundColor: '#F6EEE1', cornerRadius: '16px', borderWidth: '1px', borderColor: '#8A6A4F',
    contents: [{ type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [
      { type: 'box', layout: 'vertical', width: '14px', height: '14px', cornerRadius: '4px', backgroundColor: sec.color || PALETTE[i % 8], borderWidth: '1px', borderColor: '#755136', contents: [{ type: 'filler' }] },
      T(sec.heading, { weight: 'bold', size: 'sm', color: '#4A2A1A', wrap: true, flex: 1 })] },
      stitch('brown', 'sm'), ...cardRows(sec.rows), stitch('brown', 'md')] });
  return { type: 'bubble', size: 'mega',
    styles: { body: { backgroundColor: '#EADFCB' }, footer: { backgroundColor: '#EADFCB' } },
    header: { type: 'box', layout: 'vertical', paddingAll: '14px', paddingBottom: '10px', background: { type: 'linearGradient', angle: '180deg', startColor: '#986E51', endColor: '#8A5C3F' },
      contents: [T(c.title, { weight: 'bold', size: 'md', color: '#FFF7EC', wrap: true }), T(c.subtitle, { size: 'xs', color: '#F6E3C0', wrap: true, margin: 'xs' }), stitch('cream', 'md')] },
    body: { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '6px', contents: [...kpiRows, ...c.sections.slice(0, 10).map(paper)] },
    footer: { type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px', contents: [
      { type: 'button', style: 'primary', height: 'sm', color: '#8A5C3F', action: { type: 'uri', label: '打開產品工作站', uri: SITE } }] } };
}
// A report as text (altText, fallback and the log) and as a card, from the same parts.
const asText = (c: Card) => [c.title + ' ' + c.subtitle, ...c.sections.flatMap(sec => ['', `【${sec.heading}】`,
  ...sec.rows.map(r => r.length === 1 ? r[0] : r.length === 2 ? `${r[0]} ${r[1]}` : r.join('｜'))]), '', SITE].join('\n');

type Cell = { dl: number; sub: number; rev: number; ad: number };
const blank = (): Cell => ({ dl: 0, sub: 0, rev: 0, ad: 0 });

type Review = { id: string; c: string; r: number; t: string; b: string; v: string; at: number };
type Reviews = { at: number; products: Record<string, { rating?: number; count?: number; reviews: Review[] }> };

// The API returns at most 1000 rows a call; three weeks of one row per product, market and day is more than that.
async function metricRows(from: string, to: string) {
  const all: any[] = [];
  for (let i = 0; i < 20; i++) {
    const { data, error } = await sb.from('daily_metrics').select('product_id,date,downloads,new_subs,revenue,ad_spend')
      .gte('date', from).lte('date', to).or('sample.is.null,sample.eq.false').order('date').order('product_id').order('market').range(i * 1000, i * 1000 + 999);
    if (error) throw new Error('metrics_' + error.code);
    all.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return all;
}

async function gather(today: string) {
  const from = addDays(today, -21);
  const [rows, { data: docs }, { data: subEv }, { data: solved }] = await Promise.all([
    metricRows(from, today),
    sb.from('docs').select('collection,id,data').in('collection', ['products', 'issues', 'cfg']),
    sb.from('sub_events').select('product_id,kind,event_at').gte('event_at', new Date(Date.parse(from + 'T00:00:00+08:00')).toISOString()),
    sb.from('docs').select('id, product:data->>product, createdAt:data->createdAt, solvedAt:data->solvedAt').eq('collection', 'solved'),
  ]);
  const products = (docs || []).filter(d => d.collection === 'products' && !d.data?.sample)
    .sort((a, b) => (a.data?.createdAt || 0) - (b.data?.createdAt || 0)).map(d => ({ id: d.id as string, name: String(d.data?.name || d.id), ios: String(d.data?.ios || '').replace(/\D/g, '') }));
  const cfg = Object.fromEntries((docs || []).filter(d => d.collection === 'cfg').map(d => [d.id, d.data]));
  const bugs = (docs || []).filter(d => d.collection === 'issues' && d.data?.type === 'bug' && !['done', 'wont'].includes(d.data?.status)).map(d => ({ id: d.id as string, ...d.data }));
  const by = new Map<string, Cell>(); // product|date
  for (const r of rows) {
    const k = `${r.product_id}|${r.date}`, c = by.get(k) || blank();
    c.dl += Number(r.downloads) || 0; c.sub += Number(r.new_subs) || 0; c.rev += Number(r.revenue) || 0; c.ad += adSum(r.ad_spend);
    by.set(k, c);
  }
  const cell = (p: string, d: string) => by.get(`${p}|${d}`) || blank();
  const cancels = (p: string, d: string) => (subEv || []).filter(e => e.product_id === p && e.kind === 'cancel' && dayOf(Date.parse(e.event_at)) === d).length;
  return { products, cfg, bugs, cell, cancels, currency: String(cfg.main?.currency || 'TWD'), solved: (solved || []) as any[], reviews: (cfg.reviews || null) as Reviews | null };
}

// App Store 評論: one public feed per market (the 50 newest there), plus the Taiwan store's rating. Hourly.
async function syncReviews(g: Awaited<ReturnType<typeof gather>>) {
  const prev = g.reviews;
  if (prev && Date.now() - (prev.at || 0) < HOUR) return prev;
  const markets: string[] = ((g.cfg.main?.markets || []) as { code: string }[]).map(m => String(m.code || '').toLowerCase()).filter(c => /^[a-z]{2}$/.test(c));
  const get = async (url: string) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.ok ? await r.json() : null; } catch (_) { return null; } };
  const next: Reviews = { at: Date.now(), products: {} };
  for (const p of g.products.filter(x => x.ios)) {
    const feeds = await Promise.all((markets.length ? markets : ['tw']).map(async c => {
      const j = await get(`https://itunes.apple.com/${c}/rss/customerreviews/page=1/id=${p.ios}/sortby=mostrecent/json`);
      const e = j?.feed?.entry;
      return { c, ok: !!j, list: (Array.isArray(e) ? e : e ? [e] : []).filter((x: any) => x?.['im:rating']).map((x: any): Review => ({
        id: String(x.id?.label || ''), c: c.toUpperCase(), r: Number(x['im:rating']?.label) || 0, t: String(x.title?.label || '').slice(0, 120),
        b: String(x.content?.label || '').slice(0, 600), v: String(x['im:version']?.label || ''), at: Date.parse(x.updated?.label) || 0 })) };
    }));
    // A market whose feed didn't answer keeps the reviews it had, so they don't disappear and come back as new.
    const failed = new Set(feeds.filter(f => !f.ok).map(f => f.c.toUpperCase()));
    const kept = (prev?.products?.[p.id]?.reviews || []).filter(r => failed.has(r.c));
    const seen = new Set<string>();
    const reviews = [...feeds.flatMap(f => f.list), ...kept].filter(r => r.id && !seen.has(r.id) && seen.add(r.id)).sort((a, b) => b.at - a.at).slice(0, 40);
    const a = (await get(`https://itunes.apple.com/lookup?id=${p.ios}&country=tw&_=${Math.floor(Date.now() / HOUR)}`))?.results?.[0];
    const old = prev?.products?.[p.id];
    next.products[p.id] = { rating: a?.averageUserRating ?? old?.rating, count: a?.userRatingCount ?? old?.count, reviews };
  }
  await sb.from('docs').upsert({ collection: 'cfg', id: 'reviews', data: next, updated_at: new Date().toISOString(), updated_by: 'alerts' });
  return next;
}
const reviewsIn = (g: Awaited<ReturnType<typeof gather>>, pid: string, from: string, to: string) =>
  (g.reviews?.products?.[pid]?.reviews || []).filter(r => { const d = dayOf(r.at); return d >= from && d <= to; });
const stars = (rs: Review[]) => rs.length ? (rs.reduce((a, r) => a + r.r, 0) / rs.length).toFixed(1) : '';

function money(v: number, cur: string) {
  const n = Math.round(v).toLocaleString('en-US');
  return cur === 'TWD' ? `NT$${n}` : `${cur} ${n}`;
}
const pct = (now: number, avg: number) => avg ? `${now >= avg ? '▲' : '▼'}${Math.abs(Math.round((now - avg) / avg * 100))}%` : '';

function dailyCard(g: Awaited<ReturnType<typeof gather>>, day: string): Card {
  const prev = Array.from({ length: 7 }, (_, i) => addDays(day, -(i + 1)));
  const sections: Section[] = [], warns: Row[] = [], tot = blank();
  for (const p of g.products) {
    const c = g.cell(p.id, day);
    const avg = prev.map(d => g.cell(p.id, d)).reduce((a, x) => ({ dl: a.dl + x.dl / 7, sub: a.sub + x.sub / 7, rev: a.rev + x.rev / 7, ad: a.ad + x.ad / 7 }), blank());
    const open = g.bugs.filter(b => b.product === p.id), p0 = open.filter(b => b.priority === 'P0').length;
    const cancel = g.cancels(p.id, day);
    if (!c.dl && !c.sub && !c.rev && !c.ad && !open.length && !cancel && !avg.dl) continue;
    tot.dl += c.dl; tot.sub += c.sub; tot.rev += c.rev; tot.ad += c.ad;
    const rows: Row[] = [['下載', `${c.dl.toLocaleString('en-US')}${avg.dl >= 1 ? `（平均 ${Math.round(avg.dl)} ${pct(c.dl, avg.dl)}）` : ''}`]];
    if (c.sub || c.rev || avg.sub >= 0.5) rows.push(['新訂閱', String(c.sub)], ['營收', `${money(c.rev, g.currency)}${avg.rev >= 1 ? `（${pct(c.rev, avg.rev)}）` : ''}`]);
    if (c.ad || avg.ad) rows.push(['廣告費', money(c.ad, g.currency)]);
    if (c.ad) rows.push(['營收÷廣告費', `${(c.rev / c.ad).toFixed(2)}x`]);
    if (c.ad && c.sub) rows.push(['每個新付費用戶', money(c.ad / c.sub, g.currency)]);
    if (cancel) rows.push(['關閉續訂', String(cancel)]);
    if (open.length) rows.push(['未結案 Bug', `${open.length}${p0 ? `（緊急 ${p0}）` : ''}`]);
    const rv = reviewsIn(g, p.id, day, day);
    if (rv.length) rows.push(['新評論', `${rv.length} 則（${stars(rv)} ★）`]);
    sections.push({ heading: p.name, rows });
    const warn = (t: string) => warns.push([`${p.name}：${t}`]);
    if (avg.dl >= 20 && c.dl < avg.dl * 0.5) warn('下載不到前 7 天平均的一半');
    if (avg.sub >= 2 && c.sub === 0) warn('一整天沒有新訂閱');
    if (avg.rev > 0 && avg.sub >= 2 && c.rev < avg.rev * 0.3) warn('營收不到前 7 天平均的三成');
    if (avg.ad >= 100 && c.ad > avg.ad * 2) warn('廣告費是前 7 天平均的兩倍以上');
    if (c.ad >= 300 && c.dl < c.ad / 30) warn('廣告有花但下載很少，看一下廣告');
  }
  if (warns.length) sections.unshift({ heading: '⚠ 警訊', color: RED, rows: warns });
  const kpis: Kpi[] = [
    { label: '下載', value: tot.dl.toLocaleString('en-US'), note: '昨天・全部產品', color: '#6A3FA0' },
    { label: '新訂閱', value: String(tot.sub), note: '昨天・全部產品', color: '#3B7536' },
    { label: '營收', value: money(tot.rev, g.currency), note: '用戶付款金額', color: '#2C5E5A' },
    { label: '廣告費', value: money(tot.ad, g.currency), note: tot.ad ? `營收÷廣告費 ${(tot.rev / tot.ad).toFixed(2)}x` : '昨天沒有花費', color: '#C96614' }];
  return { title: '📊 產品工作站 日報', subtitle: `${dayLabel(day)} · 括號裡是跟前 7 天平均比`, kpis, sections };
}

// 週報: Monday to Sunday next to the week before. `mon` is the Monday after the week reported.
function weeklyCard(g: Awaited<ReturnType<typeof gather>>, mon: string): Card {
  const a0 = addDays(mon, -7), a1 = addDays(mon, -1), b0 = addDays(mon, -14), b1 = addDays(mon, -8);
  const sum = (p: string, from: string) => Array.from({ length: 7 }, (_, i) => g.cell(p, addDays(from, i))).reduce((a, x) => ({ dl: a.dl + x.dl, sub: a.sub + x.sub, rev: a.rev + x.rev, ad: a.ad + x.ad }), blank());
  const cancels = (p: string, from: string) => Array.from({ length: 7 }, (_, i) => g.cancels(p, addDays(from, i))).reduce((a, n) => a + n, 0);
  const inWeek = (t: unknown, from: string, to: string) => { const d = t ? dayOf(Number(t)) : ''; return d >= from && d <= to; };
  const n = (v: number) => v.toLocaleString('en-US'), m = (v: number) => money(v, g.currency);
  const sections: Section[] = [], tot = blank(), was = blank();
  for (const p of g.products) {
    const c = sum(p.id, a0), w = sum(p.id, b0);
    const born = [...g.bugs, ...g.solved].filter(b => b.product === p.id && inWeek(b.createdAt, a0, a1)).length;
    const fixed = g.solved.filter(b => b.product === p.id && inWeek(b.solvedAt, a0, a1)).length;
    const cx = cancels(p.id, a0), wx = cancels(p.id, b0), rv = reviewsIn(g, p.id, a0, a1);
    if (!c.dl && !c.sub && !c.rev && !c.ad && !w.dl && !born && !fixed && !cx && !rv.length) continue;
    for (const k of ['dl', 'sub', 'rev', 'ad'] as const) { tot[k] += c[k]; was[k] += w[k]; }
    const rows: Row[] = [['項目', '上週', '前一週', '變化'], ['下載', n(c.dl), n(w.dl), pct(c.dl, w.dl) || '—']];
    if (c.sub || c.rev || w.sub || w.rev) rows.push(['新訂閱', n(c.sub), n(w.sub), pct(c.sub, w.sub) || '—'], ['營收', m(c.rev), m(w.rev), pct(c.rev, w.rev) || '—']);
    if (c.ad || w.ad) rows.push(['廣告費', m(c.ad), m(w.ad), pct(c.ad, w.ad) || '—'],
      ['每個新付費用戶', c.ad && c.sub ? m(c.ad / c.sub) : '—', w.ad && w.sub ? m(w.ad / w.sub) : '—', c.ad && c.sub && w.ad && w.sub ? pct(c.ad / c.sub, w.ad / w.sub) : '—']);
    if (cx || wx) rows.push(['關閉續訂', n(cx), n(wx), pct(cx, wx) || '—']);
    // 留存: installs first opened in the week, and how many came back the next day (pushed hourly by the app).
    const coh = ((g.cfg['usage-' + p.id]?.cohorts || []) as { d: string; n: number; d1?: number }[]).filter(r => r.d1 != null);
    const d1 = (from: string, to: string) => { const x = coh.filter(r => r.d >= from && r.d <= to), k = x.reduce((a, r) => a + r.n, 0); return k >= 30 ? x.reduce((a, r) => a + (r.d1 || 0), 0) / k * 100 : null; };
    const r1 = d1(a0, a1), r0 = d1(b0, b1);
    if (r1 != null) rows.push(['隔天回來', `${r1.toFixed(1)}%`, r0 != null ? `${r0.toFixed(1)}%` : '—', r0 != null ? `${r1 >= r0 ? '▲' : '▼'}${Math.abs(r1 - r0).toFixed(1)}` : '—']);
    if (born || fixed) rows.push(['Bug', `新 ${born}・修好 ${fixed}`]);
    if (rv.length) rows.push(['評論', `${rv.length} 則（${stars(rv)} ★）`]);
    sections.push({ heading: p.name, rows });
  }
  const kpis: Kpi[] = [
    { label: '下載', value: n(tot.dl), note: `前一週 ${n(was.dl)} ${pct(tot.dl, was.dl)}`, color: '#6A3FA0' },
    { label: '新訂閱', value: n(tot.sub), note: `前一週 ${n(was.sub)} ${pct(tot.sub, was.sub)}`, color: '#3B7536' },
    { label: '營收', value: m(tot.rev), note: `前一週 ${m(was.rev)} ${pct(tot.rev, was.rev)}`, color: '#2C5E5A' },
    { label: '廣告費', value: m(tot.ad), note: tot.ad ? `營收÷廣告費 ${(tot.rev / tot.ad).toFixed(2)}x` : '上週沒有花費', color: '#C96614' }];
  return { title: '🗓 產品工作站 週報', subtitle: `${dayLabel(a0)}–${dayLabel(a1)} · 對比前一週`, kpis, sections };
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
  for (const p of g.products) for (const r of g.reviews?.products?.[p.id]?.reviews || []) {
    if (r.r <= 2 && Date.now() - r.at < 3 * DAY)
      out.push({ key: `review-${r.id}`, text: `⭐ ${r.r} 星評論（${p.name}・${r.c}${r.v ? '・' + r.v : ''}）：${[r.t, r.b].filter(Boolean).join('｜').slice(0, 160)}` });
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
  const dry = new URL(req.url).searchParams.get('dry') === '1', test = new URL(req.url).searchParams.get('test') === '1';
  const { data: prevDoc } = await sb.from('docs').select('data').match({ collection: 'cfg', id: 'alerts' }).maybeSingle();
  const st = (prevDoc?.data || {}) as Record<string, any>;
  const sent: Record<string, number> = Object.fromEntries(Object.entries(st.sent || {}).filter(([, t]) => Date.now() - Number(t) < 30 * DAY)) as Record<string, number>;
  const now = tpe(), hour = now.getUTCHours(), today = dayOf(), yesterday = addDays(today, -1);
  const out: Record<string, unknown> = { at: Date.now(), ok: true };
  try {
    const g = await gather(today);
    g.reviews = await syncReviews(g).catch(() => g.reviews);
    const monday = addDays(today, -((now.getUTCDay() + 6) % 7)); // this week's Monday
    const msgs: { card: Card; text: string; keys: string[]; daily?: boolean; weekly?: boolean }[] = [];
    const add = (card: Card, o: { keys?: string[]; daily?: boolean; weekly?: boolean }) => msgs.push({ card, text: asText(card), keys: o.keys || [], daily: o.daily, weekly: o.weekly });
    const only = new URL(req.url).searchParams.get('only'); // with ?test=1: daily | weekly | alerts
    if (test ? only !== 'weekly' && only !== 'alerts' : dry || (hour >= 9 && st.lastDaily !== yesterday)) add(dailyCard(g, yesterday), { daily: true });
    if (test ? only === 'weekly' : dry || (hour >= 9 && st.lastWeekly !== monday)) add(weeklyCard(g, monday), { weekly: true });
    const live = liveAlerts(g, today, test && only === 'alerts' ? {} : sent);
    const stamp = `${dayLabel(today)} ${String(hour).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    if (live.length && (test ? only === 'alerts' : dry || (hour >= 8 && hour < 23)))
      add({ title: '🔔 產品工作站 通知', subtitle: stamp, kpis: [], sections: [{ heading: '需要注意', color: RED, rows: live.map(a => [a.text]) }] }, { keys: live.map(a => a.key) });
    if (dry) return json({ dry: true, messages: msgs.map(m => m.text), cards: msgs.map(m => flexCard(m.card)) });
    if (test) { // sends the chosen report once more as a card, without touching what counts as already sent
      for (const m of msgs) await linePush('（測試）' + m.text, flexCard(m.card));
      return json({ test: true, sent: msgs.length, via: lineVia });
    }
    for (const m of msgs) {
      await linePush(m.text, flexCard(m.card));
      m.keys.forEach(k => sent[k] = Date.now());
      if (m.daily) st.lastDaily = yesterday;
      if (m.weekly) st.lastWeekly = monday;
    }
    out.sent = msgs.length;
    if (msgs.length) out.via = lineVia;
    out.log = [...msgs.map(m => ({ at: Date.now(), text: m.text.slice(0, 300) })), ...(st.log || [])].slice(0, 10);
  } catch (e) {
    out.ok = false; out.error = String((e as Error)?.message || e);
    out.log = st.log || [];
  }
  // Saved only when something went out or the outcome changed, so the 15-minute runs don't keep rewriting it.
  if (out.sent || out.ok !== st.ok || out.error !== st.error)
    await sb.from('docs').upsert({ collection: 'cfg', id: 'alerts', updated_at: new Date().toISOString(), updated_by: 'alerts',
      data: { ...out, lastDaily: st.lastDaily || null, lastWeekly: st.lastWeekly || null, sent } });
  return json(out);
});
