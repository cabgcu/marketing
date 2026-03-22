// Supabase Edge Function: send-push
// Sends real Web Push notifications to users' devices
//
// Required secrets (set via Supabase dashboard or CLI):
//   VAPID_PRIVATE_KEY  - base64url-encoded VAPID private key
//   VAPID_PUBLIC_KEY   - base64url-encoded VAPID public key
//   VAPID_SUBJECT      - mailto: or https: URL identifying the app
//   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key for reading app_state
//
// Deploy: supabase functions deploy send-push --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@cabmarketing.com";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Convert base64url to Uint8Array
function base64urlToUint8Array(b64url: string): Uint8Array {
  const padding = "=".repeat((4 - (b64url.length % 4)) % 4);
  const base64 = (b64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Convert Uint8Array to base64url
function uint8ArrayToBase64url(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Import VAPID private key as CryptoKey
async function importVapidPrivateKey(b64url: string): Promise<CryptoKey> {
  const raw = base64urlToUint8Array(b64url);
  // P-256 private key is 32 bytes — wrap in JWK
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: uint8ArrayToBase64url(raw),
    x: "", // Will be filled from public key
    y: "",
  };

  // Derive x,y from public key
  const pubBytes = base64urlToUint8Array(VAPID_PUBLIC_KEY);
  // Uncompressed public key: 0x04 || x (32 bytes) || y (32 bytes)
  if (pubBytes.length === 65 && pubBytes[0] === 0x04) {
    jwk.x = uint8ArrayToBase64url(pubBytes.slice(1, 33));
    jwk.y = uint8ArrayToBase64url(pubBytes.slice(33, 65));
  }

  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// Create a signed VAPID JWT
async function createVapidJwt(audience: string, privateKey: CryptoKey): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 12 * 3600,
    sub: VAPID_SUBJECT,
  };

  const encodeJson = (obj: unknown) => uint8ArrayToBase64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsignedToken = encodeJson(header) + "." + encodeJson(payload);

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  // Convert DER signature to raw r||s format (already raw from WebCrypto)
  return unsignedToken + "." + uint8ArrayToBase64url(new Uint8Array(signature));
}

// Encrypt push payload using the subscription's keys (RFC 8291)
async function encryptPayload(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string
): Promise<{ body: Uint8Array; headers: Record<string, string> }> {
  const userPublicKeyBytes = base64urlToUint8Array(subscription.keys.p256dh);
  const authSecret = base64urlToUint8Array(subscription.keys.auth);

  // Import the user's public key
  const userPublicKey = await crypto.subtle.importKey(
    "raw",
    userPublicKeyBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // Generate a local ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", localKeyPair.publicKey));

  // Derive shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: userPublicKey }, localKeyPair.privateKey, 256)
  );

  // HKDF helper
  async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
    return new Uint8Array(bits);
  }

  // Build info strings per RFC 8291
  function createInfo(type: string, clientPublic: Uint8Array, serverPublic: Uint8Array): Uint8Array {
    const label = new TextEncoder().encode("Content-Encoding: " + type + "\0P-256\0");
    const info = new Uint8Array(label.length + 2 + clientPublic.length + 2 + serverPublic.length);
    let offset = 0;
    info.set(label, offset); offset += label.length;
    info[offset++] = 0; info[offset++] = clientPublic.length;
    info.set(clientPublic, offset); offset += clientPublic.length;
    info[offset++] = 0; info[offset++] = serverPublic.length;
    info.set(serverPublic, offset);
    return info;
  }

  // Derive PRK from auth secret
  const authInfo = new TextEncoder().encode("Content-Encoding: auth\0");
  const prk = await hkdf(authSecret, sharedSecret, authInfo, 32);

  // Derive content encryption key and nonce
  const cekInfo = createInfo("aesgcm", userPublicKeyBytes, localPublicKeyRaw);
  const nonceInfo = createInfo("nonce", userPublicKeyBytes, localPublicKeyRaw);
  const contentEncryptionKey = await hkdf(prk, new Uint8Array(32), cekInfo, 16);
  const nonce = await hkdf(prk, new Uint8Array(32), nonceInfo, 12);

  // Pad and encrypt payload
  const payloadBytes = new TextEncoder().encode(payload);
  const paddingLength = 2;
  const padded = new Uint8Array(paddingLength + payloadBytes.length);
  padded[0] = 0; padded[1] = 0; // 2-byte padding length = 0 (no extra padding)
  padded.set(payloadBytes, paddingLength);

  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  return {
    body: encrypted,
    headers: {
      "Content-Encoding": "aesgcm",
      "Crypto-Key": "dh=" + uint8ArrayToBase64url(localPublicKeyRaw),
      Encryption: "salt=" + uint8ArrayToBase64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" },
    });
  }

  try {
    const { targets, notification } = await req.json();

    if (!targets || !notification) {
      return new Response(JSON.stringify({ error: "Missing targets or notification" }), { status: 400 });
    }

    // Read push subscriptions from app_state
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await supabase.from("app_state").select("data").eq("id", 1).single();
    if (error || !data?.data) {
      return new Response(JSON.stringify({ error: "Could not read app_state" }), { status: 500 });
    }

    const subscriptions = data.data.pushSubscriptions || {};
    const privateKey = await importVapidPrivateKey(VAPID_PRIVATE_KEY);
    const results: Record<string, string> = {};

    for (const userName of targets) {
      const sub = subscriptions[userName];
      if (!sub?.endpoint || !sub?.keys) {
        results[userName] = "no_subscription";
        continue;
      }

      try {
        const payload = JSON.stringify(notification);
        const encrypted = await encryptPayload(sub, payload);
        const audience = new URL(sub.endpoint).origin;
        const jwt = await createVapidJwt(audience, privateKey);

        const resp = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            ...encrypted.headers,
            Authorization: `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
            TTL: "86400",
            "Content-Type": "application/octet-stream",
            Urgency: "high",
          },
          body: encrypted.body,
        });

        results[userName] = resp.ok ? "sent" : `error_${resp.status}`;

        // If subscription expired/invalid, clean it up
        if (resp.status === 404 || resp.status === 410) {
          delete subscriptions[userName];
          await supabase
            .from("app_state")
            .update({ data: { ...data.data, pushSubscriptions: subscriptions } })
            .eq("id", 1);
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
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
});
