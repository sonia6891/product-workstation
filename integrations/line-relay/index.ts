// Edge function `line-relay` (workstation project): sends a LINE message to the owner from the official account
// 產品工作站, for a source app that has no token of its own. 喵的，又要上班了 hands its hourly 變動通知 here
// (its edge function line-push), so the owner's reports all arrive in one LINE account and the token lives in one place.
// POST { key, product, text, flex?, retry_key? }: `key` is the app's push key (the one ingest_metrics takes, checked by
// public.check_ingest_key). With `flex` the card is sent first; if LINE rejects it, `text` goes out instead.
// `retry_key` (a UUID) is passed to LINE as X-Line-Retry-Key: LINE delivers one message per key and answers 409 to a
// repeat, so a caller that may report the same event twice (a store notification and its retry) reaches the owner once.
// Needs the secret WORKSTATION_LINE_TOKEN; the recipient is threads_config.line_user_id_workstation.
// When that account cannot send (its monthly free messages used up = 429, not a friend yet…), the bot shared with
// 串文雷達 sends instead (LINE_CHANNEL_ACCESS_TOKEN → threads_config.line_user_id), like `alerts` does.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? '').trim();
  if (!text) return json({ ok: false, error: 'text is required' }, 400);
  const { data: allowed } = await sb.rpc('check_ingest_key', { p_key: String(body.key ?? ''), p_product: String(body.product ?? '') });
  if (allowed !== true) return json({ ok: false, error: 'unauthorized' }, 401);

  const env = (k: string) => (Deno.env.get(k) || '').trim();
  const okId = (s: string) => /^U[0-9a-f]{32}$/.test(s);
  const { data: ids } = await sb.from('threads_config').select('key,value').in('key', ['line_user_id', 'line_user_id_workstation']);
  const cfgId = (k: string) => String((ids || []).find((r) => r.key === k)?.value || '').trim();
  const accounts = [
    { via: 'workstation', token: env('WORKSTATION_LINE_TOKEN'), to: cfgId('line_user_id_workstation') },
    { via: 'shared', token: env('LINE_CHANNEL_ACCESS_TOKEN'), to: [cfgId('line_user_id'), env('LINE_USER_ID')].find(okId) || '' },
  ].filter((a) => a.token && okId(a.to));
  if (!accounts.length) return json({ ok: false, error: 'not_configured' }, 503);

  const retryKey = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(body.retry_key ?? '')) ? String(body.retry_key) : '';
  const plain = [{ type: 'text', text: text.slice(0, 4900) }];
  const tried: string[] = [];
  for (const a of accounts) {
    const send = async (messages: unknown[]) => {
      const status = (await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}`, 'X-Line-Retry-Key': retryKey || crypto.randomUUID() },
        body: JSON.stringify({ to: a.to, messages }),
      }).catch(() => ({ status: 0 }))).status;
      return retryKey && status === 409 ? 200 : status; // 409 = LINE already delivered this key
    };
    let format = 'text', status = 0;
    if (body.flex && typeof body.flex === 'object') {
      status = await send([{ type: 'flex', altText: text.slice(0, 380), contents: body.flex }]);
      format = 'flex';
      if (status === 400) { status = await send(plain); format = 'text-fallback'; }
    } else status = await send(plain);
    if (status >= 200 && status < 300) return json({ ok: true, format, via: a.via, tried });
    tried.push(`${a.via}:${status}`);
  }
  return json({ ok: false, error: `line_${tried.join(',')}` }, 502);
});
