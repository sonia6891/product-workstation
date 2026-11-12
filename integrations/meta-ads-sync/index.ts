// Edge function `meta-ads-sync` (workstation project): Meta 廣告費 → 數據 (daily_metrics.ad_spend.Meta).
// Reads each day's spend per campaign and country from the official Meta Marketing API (read-only), works out which
// product each campaign promotes (the App Store / Google Play link on its ad sets, else the product name in the
// campaign name), converts to the workstation currency and hands it to public.ingest_ad_spend (integrations/meta-ads.sql).
// Called hourly by pg_cron. The first successful run fills everything since BACKFILL_FROM; later runs redo the last
// WINDOW_DAYS days, since Meta keeps adjusting recent spend. Status (never the token) goes to cfg/meta-ads.
// Needs the secret META_ACCESS_TOKEN (ads_read). META_AD_ACCOUNT may override the ad account id.
// No caller auth on purpose: it only reads Meta and refreshes these rows, and runs at most once every 10 minutes.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const GRAPH = 'https://graph.facebook.com/v24.0';
const ACCOUNT = (Deno.env.get('META_AD_ACCOUNT') || '797721634200820').replace(/^act_/, '');
const BACKFILL_FROM = '2026-09-01';
const WINDOW_DAYS = 7;
const CHANNEL = 'Meta';
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } });

// A day in the ad account's own time zone (Meta reports days in it).
const dayIn = (tz: string, t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

async function graph(path: string, token: string, params: Record<string, string> = {}) {
  const out: any[] = [];
  let url: string | null = `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  for (let page = 0; url && page < 50; page++) {
    const r = await fetch(url);
    const b = await r.json().catch(() => ({}));
    if (!r.ok || b.error) {
      const e = b.error || {};
      // 190 = token expired/invalid, 10/200-299 = missing permission, 4/17/32/613 = rate limits.
      const code = e.code === 190 ? 'token_rejected' : (e.code === 10 || (e.code >= 200 && e.code < 300)) ? 'no_permission'
        : [4, 17, 32, 613, 80000, 80004].includes(e.code) ? 'rate_limited' : `meta_${r.status}`;
      throw Object.assign(new Error(code), { detail: String(e.message || '').slice(0, 300) });
    }
    if (!Array.isArray(b.data)) return b;
    out.push(...b.data);
    url = b.paging?.next || null;
  }
  if (url) throw new Error('too_many_pages');
  return out;
}

async function rateToWorkstation(from: string, to: string) {
  if (from === to) return 1;
  const r = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
  const b = await r.json().catch(() => ({}));
  const v = Number(b?.rates?.[to]);
  if (!r.ok || !(v > 0)) throw new Error('no_exchange_rate');
  return v;
}

Deno.serve(async () => {
  const { data: prev } = await sb.from('docs').select('data').match({ collection: 'cfg', id: 'meta-ads' }).maybeSingle();
  const last = (prev?.data || {}) as Record<string, any>;
  if (last.ok && Date.now() - (last.at || 0) < 10 * 60_000) return json({ skipped: true });

  const token = Deno.env.get('META_ACCESS_TOKEN');
  const status: Record<string, unknown> = { at: Date.now(), ok: false, account: ACCOUNT, backfilled: !!last.backfilled };
  try {
    if (!token) throw new Error('no_token');
    const [{ data: main }, { data: prods }] = await Promise.all([
      sb.from('docs').select('data').match({ collection: 'cfg', id: 'main' }).maybeSingle(),
      sb.from('docs').select('id,data').eq('collection', 'products'),
    ]);
    const currency = String(main?.data?.currency || 'TWD');
    const products = (prods || []).map(p => ({ id: p.id as string, name: String(p.data?.name || ''), ios: String(p.data?.ios || '').replace(/\D/g, ''),
      android: String(p.data?.android || '').trim() }));

    const acct = await graph(`act_${ACCOUNT}`, token, { fields: 'currency,timezone_name,name' });
    const tz = acct.timezone_name || 'Asia/Taipei';
    const rate = await rateToWorkstation(acct.currency, currency);
    const to = dayIn(tz);
    const from = last.backfilled ? addDays(to, -(WINDOW_DAYS - 1)) : BACKFILL_FROM;
    Object.assign(status, { from, to, timezone: tz, adCurrency: acct.currency, currency, rate });

    // Which product a campaign promotes: the store link on its ad sets (App promotion campaigns always have one).
    // Archived ad sets are included so old campaigns still find their product; plain list if Meta refuses the filter.
    const adsetFields = { fields: 'campaign_id,promoted_object', limit: '500' };
    const adsets = await graph(`act_${ACCOUNT}/adsets`, token, { ...adsetFields,
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES']) })
      .catch(e => (e as Error).message === 'token_rejected' ? Promise.reject(e) : graph(`act_${ACCOUNT}/adsets`, token, adsetFields));
    const storeOf = new Map<string, string>();
    for (const a of adsets) {
      const po = a.promoted_object || {};
      const link = [po.object_store_url, po.application_id].filter(Boolean).join(' ');
      if (link) storeOf.set(a.campaign_id, (storeOf.get(a.campaign_id) || '') + ' ' + link);
    }
    const productOf = (campaignId: string, campaignName: string) => {
      const link = storeOf.get(campaignId) || '';
      const byLink = products.find(p => (p.ios && link.includes(p.ios)) || (p.android && link.includes(p.android)));
      if (byLink) return byLink.id;
      const name = campaignName.toLowerCase();
      return products.find(p => (p.name && name.includes(p.name.toLowerCase())) || name.includes(p.id.toLowerCase()))?.id || '';
    };

    const insights = await graph(`act_${ACCOUNT}/insights`, token, {
      level: 'campaign', fields: 'campaign_id,campaign_name,spend', breakdowns: 'country', time_increment: '1',
      time_range: JSON.stringify({ since: from, until: to }), limit: '500',
    });
    const rows: { p: string; m: string; d: string; v: number }[] = [];
    const byProduct: Record<string, number> = {};
    const unmatched = new Map<string, { name: string; spend: number }>();
    let total = 0;
    for (const i of insights) {
      const spend = Number(i.spend) || 0;
      if (!spend) continue;
      const v = Math.round(spend * rate * 100) / 100;
      total += v;
      const p = productOf(i.campaign_id, String(i.campaign_name || ''));
      if (!p) {
        const u = unmatched.get(i.campaign_id) || { name: String(i.campaign_name || i.campaign_id), spend: 0 };
        u.spend += v; unmatched.set(i.campaign_id, u);
        continue;
      }
      byProduct[p] = (byProduct[p] || 0) + v;
      const m = String(i.country || '').toUpperCase();
      rows.push({ p, m: /^[A-Z]{2}$/.test(m) ? m : 'OTHER', d: i.date_start, v });
    }

    const { data: res, error } = await sb.rpc('ingest_ad_spend', { p_channel: CHANNEL, p_from: from, p_to: to, p_rows: rows });
    if (error) throw error;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    Object.assign(status, {
      ok: true, backfilled: true, total: r2(total), rows: rows.length, changed: (res as any)?.changed ?? 0,
      products: Object.fromEntries(Object.entries(byProduct).map(([k, v]) => [k, r2(v)])),
      unmatched: [...unmatched.values()].map(u => ({ name: u.name.slice(0, 120), spend: r2(u.spend) })),
    });
  } catch (e) {
    status.error = String((e as Error)?.message || e);
    if ((e as any)?.detail) status.detail = (e as any).detail;
  }
  await sb.from('docs').upsert({ collection: 'cfg', id: 'meta-ads', data: status, updated_at: new Date().toISOString(), updated_by: 'meta-ads' });
  return json(status);
});
