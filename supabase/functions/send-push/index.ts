// Supabase Edge Function: send-push
// Sends a wake-up push to users' devices (no encrypted payload needed)
// The service worker fetches notification content from Supabase when it wakes up

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@cabmarketing.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function base64urlToUint8Array(b64url: string): Uint8Array {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function uint8ArrayToBase64url(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importVapidPrivateKey(): Promise<CryptoKey> {
  const raw = base64urlToUint8Array(VAPID_PRIVATE_KEY);
  const pubBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY);

  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: uint8ArrayToBase64url(raw),
    x: uint8ArrayToBase64url(pubBytes.slice(1, 33)),
    y: uint8ArrayToBase64url(pubBytes.slice(33, 65)),
  };

  return crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
}

async function createVapidJwt(audience: string, privateKey: CryptoKey): Promise<string> {
  const encode = (obj: unknown) =>
    uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)));

  const header = encode({ typ: "JWT", alg: "ES256" });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({ aud: audience, exp: now + 12 * 3600, sub: VAPID_SUBJECT });
  const unsigned = header + "." + payload;

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(unsigned)
  );

  return unsigned + "." + uint8ArrayToBase64url(new Uint8Array(sig));
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  try {
    const { targets } = await req.json();
    if (!targets || !Array.isArray(targets) || targets.length === 0) {
      return new Response(JSON.stringify({ error: "Missing targets array" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Read push subscriptions from app_state
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from("app_state").select("data").eq("id", 1).single();
    if (error || !data?.data) {
      return new Response(JSON.stringify({ error: "Could not read app_state", details: error }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const subscriptions = data.data.pushSubscriptions || {};
    const privateKey = await importVapidPrivateKey();
    const results: Record<string, string> = {};

    for (const userName of targets) {
      const sub = subscriptions[userName];
      if (!sub?.endpoint || !sub?.keys) {
        results[userName] = "no_subscription";
        continue;
      }

      try {
        const audience = new URL(sub.endpoint).origin;
        const jwt = await createVapidJwt(audience, privateKey);

        // Send empty push (no payload = no encryption needed)
        // The service worker will fetch notification content from Supabase
        const resp = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
            TTL: "86400",
            "Content-Length": "0",
            Urgency: "high",
          },
        });

        const respText = await resp.text();
        results[userName] = resp.ok ? "sent" : `error_${resp.status}: ${respText}`;

        // Clean up expired subscriptions
        if (resp.status === 404 || resp.status === 410) {
          delete subscriptions[userName];
          await supabase
            .from("app_state")
            .update({ data: { ...data.data, pushSubscriptions: subscriptions } })
            .eq("id", 1);
          results[userName] = "subscription_expired";
        }
      } catch (err) {
        results[userName] = "error: " + (err as Error).message;
      }
    }

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
});
