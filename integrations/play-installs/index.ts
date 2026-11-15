// play-installs (Supabase project meow-work): Google Play's official install numbers for the workstation.
// Google writes a monthly CSV per app into the developer account's Cloud Storage bucket
// (gs://pubsite_prod_<developer id>/stats/installs/installs_<package>_<YYYYMM>_country.csv, UTF-16, refreshed daily,
// about two days behind). This reads this month's and last month's file with the Play service account
// (GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, which needs 查看應用程式資訊及下載大量報表 in Play Console) and keeps one row per
// day and country in public.play_install_rows. workstation.export_rows() then uses those days for Android 下載
// instead of first opens, the same way Apple's SALES report replaces first opens on iPhone.
// "Install events" (every install, re-installs too) is used when the file has it, like Apple's units that count
// re-downloads; older files fall back to "Daily Device Installs".
// Called every few hours by pg_cron with the anon key; it only reads Google and writes that one table.
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = Deno.env.get("GOOGLE_PLAY_REPORT_BUCKET") || "pubsite_prod_7117137656805505812";
const PACKAGE = Deno.env.get("GOOGLE_PLAY_PACKAGE_NAME") || "com.lumilab.meowwork";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const encJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function account() {
  let a: any = JSON.parse(String(Deno.env.get("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON") || "").trim() || "null");
  if (typeof a === "string") a = JSON.parse(a);
  if (a?.default && typeof a.default === "string") a = JSON.parse(a.default);
  if (!a?.client_email || !a?.private_key) throw new Error("google_play_not_configured");
  return a;
}

async function token() {
  const a = account(), now = Math.floor(Date.now() / 1000);
  const unsigned = `${encJson({ alg: "RS256", typ: "JWT", kid: a.private_key_id })}.${encJson({
    iss: a.client_email, scope: "https://www.googleapis.com/auth/devstorage.read_only",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const pem = a.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!r.ok) throw new Error("google_oauth_failed");
  return String((await r.json()).access_token || "");
}

function decode(buf: ArrayBuffer) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  return new TextDecoder().decode(b).replace(/^﻿/, "");
}

function parse(csv: string) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift()!.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const col = (n: string) => head.indexOf(n);
  const iDate = col("Date"), iCountry = col("Country");
  const iN = col("Install events") >= 0 ? col("Install events") : col("Daily Device Installs");
  if (iDate < 0 || iCountry < 0 || iN < 0) throw new Error("unexpected_report_columns:" + head.join("|"));
  return lines.map((l) => l.split(",").map((x) => x.trim().replace(/^"|"$/g, ""))).map((c) => ({
    report_date: c[iDate], country: (c[iCountry] || "").toUpperCase() || "ZZ", installs: Math.max(0, Math.round(Number(c[iN]) || 0)),
  })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.report_date));
}

Deno.serve(async () => {
  try {
    const t = await token(), now = new Date();
    const months = [0, 1].map((k) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; });
    const rows: { report_date: string; country: string; installs: number }[] = [], files: string[] = [];
    for (const ym of months) {
      const name = `stats/installs/installs_${PACKAGE}_${ym}_country.csv`;
      const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(name)}?alt=media`, { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 404) continue;
      if (!r.ok) return Response.json({ ok: false, error: `storage_${r.status}`, file: name }, { status: 502 });
      rows.push(...parse(decode(await r.arrayBuffer()))); files.push(name);
    }
    // One row per day and country (the file can list a country twice when Google renames it).
    const merged = new Map<string, { report_date: string; country: string; installs: number }>();
    for (const r of rows) { const k = r.report_date + "|" + r.country; const m = merged.get(k); if (m) m.installs += r.installs; else merged.set(k, { ...r }); }
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const list = [...merged.values()].map((r) => ({ ...r, fetched_at: new Date().toISOString() }));
    if (list.length) { const { error } = await admin.from("play_install_rows").upsert(list); if (error) throw error; }
    return Response.json({ ok: true, files, rows: list.length });
  } catch (e) {
    return Response.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
});
