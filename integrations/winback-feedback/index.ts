// Edge function `winback-feedback` (workstation project): records what people answer on the 挽回信 page.
// Each letter's links carry a per-person token (private.winback_recipients.token) instead of the address, so the token
// is the only proof needed; unknown tokens are rejected. The page (Cloudflare Worker on meow.pocketjoystudio.com,
// integrations/winback-page/worker.js) POSTs {t, reason?, comeback?, comment?} here; every field sent overwrites the
// stored one, so a person can change their mind (public.winback_answer). Deployed with verify_jwt off.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const REASONS = new Set(["price", "feature", "bug", "notneeded", "other"]);
const COMEBACK = new Set(["yes", "maybe", "no"]);
const cors = {
  "access-control-allow-origin": "https://meow.pocketjoystudio.com",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    const t = String(b.t || "");
    if (!/^[0-9a-f]{24}$/.test(t)) return json({ ok: false, error: "token" }, 400);
    if (b.reason != null && !REASONS.has(String(b.reason))) return json({ ok: false, error: "reason" }, 400);
    if (b.comeback != null && !COMEBACK.has(String(b.comeback))) return json({ ok: false, error: "comeback" }, 400);
    const { data: product, error } = await sb.rpc("winback_answer", {
      p_token: t,
      p_reason: b.reason == null ? null : String(b.reason),
      p_comeback: b.comeback == null ? null : String(b.comeback),
      p_comment: b.comment == null ? null : String(b.comment).slice(0, 2000),
    });
    if (error) throw error;
    if (!product) return json({ ok: false, error: "token" }, 404);
    return json({ ok: true, product });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
