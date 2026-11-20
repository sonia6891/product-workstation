// Verifies a JWS Apple signed (server notification, transaction): the x5c chain must lead to an Apple root
// certificate and the signature must match. WebCrypto, because Apple's library does not run on Deno's node:crypto.
// Same checks as mm-iap/apple.ts; no OCSP revocation check.
import * as x509 from "npm:@peculiar/x509@1.12.3";

const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";
const ROOT_URLS = [
  "https://www.apple.com/appleca/AppleIncRootCertificate.cer",
  "https://www.apple.com/certificateauthority/AppleRootCA-G2.cer",
  "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer",
];

// deno-lint-ignore no-explicit-any
export type Signed = Record<string, any>;

function b64url(part: string): Uint8Array<ArrayBuffer> {
  const s = part.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(s + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function json(part: string): Signed {
  return JSON.parse(new TextDecoder().decode(b64url(part)));
}

function within(cert: x509.X509Certificate, date: Date): boolean {
  return cert.notBefore <= date && date <= cert.notAfter;
}

let roots: Promise<x509.X509Certificate[]> | null = null;
function appleRoots(): Promise<x509.X509Certificate[]> {
  roots ??= Promise.all(ROOT_URLS.map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error("apple_root_fetch_failed");
    return new x509.X509Certificate(new Uint8Array(await res.arrayBuffer()));
  })).catch((e) => {
    roots = null;
    throw e;
  });
  return roots;
}

export async function verifyJws(jws: string): Promise<Signed> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw new Error("invalid_jws");
  const header = json(parts[0]);
  if (header?.alg !== "ES256") throw new Error("invalid_algorithm");
  const chain: string[] = Array.isArray(header?.x5c) ? header.x5c : [];
  if (chain.length !== 3) throw new Error("invalid_chain_length");
  const leaf = new x509.X509Certificate(chain[0]);
  const intermediate = new x509.X509Certificate(chain[1]);
  const now = new Date();

  let root: x509.X509Certificate | undefined;
  for (const candidate of await appleRoots()) {
    if (
      intermediate.issuer === candidate.subject &&
      await intermediate.verify({ publicKey: candidate.publicKey, signatureOnly: true })
    ) {
      root = candidate;
      break;
    }
  }
  const valid = !!root &&
    leaf.issuer === intermediate.subject &&
    await leaf.verify({ publicKey: intermediate.publicKey, signatureOnly: true }) &&
    intermediate.getExtension(x509.BasicConstraintsExtension)?.ca === true &&
    !!leaf.getExtension(LEAF_OID) &&
    !!intermediate.getExtension(INTERMEDIATE_OID) &&
    within(leaf, now) && within(intermediate, now) && within(root, now);
  if (!valid) throw new Error("verification_failure");

  const key = await leaf.publicKey.export({ name: "ECDSA", namedCurve: "P-256" }, ["verify"]);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64url(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!ok) throw new Error("invalid_signature");
  return json(parts[1]);
}
