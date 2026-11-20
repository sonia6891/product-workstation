// App Store Server Notifications V2 for apps with no server of their own (額度雷達 / QuotaRadar, owner 2026-11-21:
// Apple's daily report is a day late, the numbers must come from our own Supabase right away).
// App Store Connect → the app → App 資訊 → App Store 伺服器通知: Production and Sandbox URL
//   https://bpovoxjdqdwhhlfwgpep.supabase.co/functions/v1/app-store-notifications
// Apple signs every notification, so no login is needed: the chain is checked against Apple's root certificates,
// and the bundle id / Apple app id must be one in private.apple_apps (public.ingest_apple_notification, SQL in
// integrations/apple-notifications.sql). Only Production purchases count; Sandbox and TestFlight are logged only.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { type Signed, verifyJws } from "./apple.ts";

function key(json: string, legacy: string): string {
  const old = Deno.env.get(legacy);
  if (old) return old;
  const keys = JSON.parse(Deno.env.get(json) ?? "{}") as Record<string, string>;
  return keys.default ?? Object.values(keys)[0] ?? "";
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply(200, { ok: true });
  let signedPayload = "";
  try {
    signedPayload = String((await req.json())?.signedPayload ?? "");
  } catch {
    return reply(400, { error: "bad_json" });
  }
  if (!signedPayload) return reply(400, { error: "missing_signedPayload" });
  try {
    const n = await verifyJws(signedPayload);
    const data: Signed = n.data ?? {};
    let tx: Signed | null = null;
    if (typeof data.signedTransactionInfo === "string") {
      tx = await verifyJws(data.signedTransactionInfo);
      if (tx.bundleId !== data.bundleId) return reply(400, { error: "bundle_mismatch" });
    }
    const db = createClient(Deno.env.get("SUPABASE_URL")!, key("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
    const { data: out, error } = await db.rpc("ingest_apple_notification", {
      p: {
        uuid: n.notificationUUID,
        type: n.notificationType,
        subtype: n.subtype ?? null,
        signed_at: n.signedDate,
        bundle_id: data.bundleId,
        app_apple_id: data.appAppleId ?? null,
        environment: data.environment,
        tx: tx && {
          id: tx.transactionId,
          original_id: tx.originalTransactionId,
          product: tx.productId,
          type: tx.type,
          purchased_at: tx.purchaseDate,
          revoked_at: tx.revocationDate ?? null,
          price: tx.price ?? null,
          currency: tx.currency ?? null,
          storefront: tx.storefront ?? null,
          ownership: tx.inAppOwnershipType ?? null,
        },
      },
    });
    if (error) throw new Error("db_failed: " + error.message);
    // An app we do not know is answered 200 too, so Apple stops retrying it.
    return reply(200, { ok: true, result: out });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("app-store-notifications", msg);
    // 5xx: Apple retries later (1, 12, 24, 48 and 72 hours).
    return reply(msg === "apple_root_fetch_failed" || msg.startsWith("db_failed") ? 503 : 400, { error: msg });
  }
});
