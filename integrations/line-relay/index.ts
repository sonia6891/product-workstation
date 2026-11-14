// Edge function `line-relay` (workstation project): sends a LINE message to the owner from the official account
// 產品工作站, for a source app that has no token of its own. 喵的，又要上班了 hands its hourly 變動通知 here
// (its edge function line-push), so the owner's reports all arrive in one LINE account and the token lives in one place.
// POST { key, product, text, flex? }: `key` is the app's push key (the one ingest_metrics takes, checked by
// public.check_ingest_key). With `flex` the card is sent first; if LINE rejects it, `text` goes out instead.
// Needs the secret WORKSTATION_LINE_TOKEN; the recipient is threads_config.line_user_id_workstation.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? '').trim();
  if (!text) return json({ ok: false, error: 'text is required' }, 400);
  const { data: allowed } = await sb.rpc('check_ingest_key', { p_key: String(body.key ?? ''), p_product: String(body.product ?? '') });
  if (allowed !== true) return json({ ok: false, error: 'unauthorized' }, 401);

  const token = (Deno.env.get('WORKSTATION_LINE_TOKEN') || '').trim();
  const { data } = await sb.from('threads_config').select('value').eq('key', 'line_user_id_workstation').maybeSingle();
  const to = String(data?.value || '').trim();
  if (!token || !/^U[0-9a-f]{32}$/.test(to)) return json({ ok: false, error: 'not_configured' }, 503);

  const send = async (messages: unknown[]) => (await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Line-Retry-Key': crypto.randomUUID() },
    body: JSON.stringify({ to, messages }),
  })).status;
  const plain = [{ type: 'text', text: text.slice(0, 4900) }];
  let format = 'text', status = 0;
  if (body.flex && typeof body.flex === 'object') {
    status = await send([{ type: 'flex', altText: text.slice(0, 380), contents: body.flex }]);
    format = 'flex';
    if (status < 200 || status >= 300) { status = await send(plain); format = 'text-fallback'; }
  } else status = await send(plain);
  if (status < 200 || status >= 300) return json({ ok: false, error: `line_${status}` }, 502);
  return json({ ok: true, format });
});
