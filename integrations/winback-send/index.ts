// Edge function `winback-send` (workstation project): mails a product's 挽回信 to everyone on its list not mailed yet
// (private.winback_recipients, filled by each app's hourly push; see integrations/winback.sql), from
// sonia@pocketjoystudio.com through Resend. The letters live in ./letters (one per product and campaign).
// Called from 退訂紀錄 → 寄挽回信 by a signed-in owner or editor, or by the server with x-alerts-secret
// (threads_config.cron_secret). Body {product, campaign?='winback-1', dry?}: dry only counts.
// Needs the secret RESEND_API_KEY. Each send carries an Idempotency-Key, so a double press mails a person once.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { LETTERS } from "./letters/index.ts";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const sb = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-alerts-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const FROM_ADDR = "sonia@pocketjoystudio.com";
const UNSUB = "<mailto:sonia@pocketjoystudio.com?subject=%E4%B8%8D%E7%94%A8%E4%BA%86>"; // subject 不用了

const b64 = (buf: ArrayBuffer) => { const b = new Uint8Array(buf); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

async function allowed(req: Request) {
  const secret = req.headers.get("x-alerts-secret");
  if (secret) {
    const { data } = await sb.from("threads_config").select("value").eq("key", "cron_secret").maybeSingle();
    return !!data?.value && secret === data.value;
  }
  const anon = createClient(URL_, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false },
  });
  const { data: { user } } = await anon.auth.getUser();
  const email = (user?.email ?? "").toLowerCase();
  if (!email) return false;
  const { data } = await sb.from("members").select("role").eq("email", email).maybeSingle();
  return ["owner", "editor"].includes(String(data?.role || ""));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  try {
    if (!(await allowed(req))) return json({ ok: false, error: "no_permission" }, 403);
    const body = await req.json().catch(() => ({}));
    const product = String(body.product || ""), campaign = String(body.campaign || "winback-1");
    const letter = LETTERS[product]?.[campaign.startsWith("test") ? "winback-1" : campaign];
    if (!letter) return json({ ok: false, error: "no_letter" }, 400);
    const { data: rows, error } = await sb.rpc("winback_pending", { p_product: product, p_campaign: campaign });
    if (error) throw error;
    if (body.dry) return json({ ok: true, dry: true, would_send: rows.length });
    if (!rows.length) return json({ ok: true, sent: 0 });
    const key = Deno.env.get("RESEND_API_KEY");
    if (!key) return json({ ok: false, error: "resend_not_configured" }, 500);

    const attachments = await Promise.all(Object.entries(letter.images).map(async ([id, url]) => {
      const r = await fetch(url); if (!r.ok) throw new Error(`image_${id}_${r.status}`);
      return { filename: `${id}.${url.split(".").pop()}`, content: b64(await r.arrayBuffer()), content_id: id };
    }));
    const results: { ok: boolean; error?: string }[] = [];
    for (const row of rows as { token: string; email: string }[]) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "Idempotency-Key": `${product}-${campaign}-${row.token}` },
        body: JSON.stringify({
          from: `${letter.fromName} <${FROM_ADDR}>`, to: [row.email], reply_to: FROM_ADDR, subject: letter.subject,
          html: letter.html.replaceAll("{{TOKEN}}", row.token), text: letter.text(row.token), attachments,
          headers: { "List-Unsubscribe": UNSUB },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { await sb.rpc("winback_mark_sent", { p_token: row.token }); results.push({ ok: true }); }
      else results.push({ ok: false, error: `${r.status} ${j.message || ""}` });
    }
    const failed = results.filter((x) => !x.ok);
    return json({ ok: !failed.length, sent: results.length - failed.length, failed: failed.length, errors: failed.map((x) => x.error).slice(0, 5) });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
