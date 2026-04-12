/**
 * push-notify Edge Function
 *
 * 毎朝 08:00 JST (23:00 UTC) に Supabase Cron から呼ばれる想定。
 *
 * Supabase ダッシュボード > Edge Functions > Secrets に以下を登録:
 *   VAPID_PUBLIC_KEY   = BNbaJJlWNEwlkbRPPJjgU_NAtj-hUc_d8qksT3aoSlsBaxuCDwnMYYgeM0gzVcd6Qqd-J2xGJ4DzPX4FjCsrcug
 *   VAPID_PRIVATE_KEY  = 1JKz33hph0H7M235U93zhJFIS7JKFmPAd_Cpv5TSmFY
 *   CRON_SECRET        = <任意の長いランダム文字列>
 *
 * Supabase ダッシュボード > Database > Extensions で pg_net を有効化し、
 * SQL Editor で以下を実行して毎朝 08:00 JST (= 23:00 UTC) にトリガー:
 *
 *   SELECT cron.schedule(
 *     'push-notify-daily',
 *     '0 23 * * *',
 *     $$
 *     SELECT net.http_post(
 *       url := 'https://<project-ref>.supabase.co/functions/v1/push-notify',
 *       headers := '{"Authorization":"Bearer <CRON_SECRET>","Content-Type":"application/json"}'::jsonb,
 *       body := '{}'::jsonb
 *     );
 *     $$
 *   );
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// ── VAPID JWT / Web Push helper ──────────────────────────────────────────────

const VAPID_EMAIL = "mailto:no-reply@my-calendar.app";

/** base64url → Uint8Array */
function b64uDecode(str: string): Uint8Array {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Uint8Array → base64url (no padding) */
function b64uEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

async function makeVapidHeaders(
  audience: string,
  vapidPublic: string,
  vapidPrivate: string,
): Promise<{ Authorization: string; "Crypto-Key": string }> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64uEncode(
    new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = b64uEncode(
    new TextEncoder().encode(
      JSON.stringify({ aud: audience, exp: now + 43200, sub: VAPID_EMAIL }),
    ),
  );
  const sigInput = new TextEncoder().encode(`${header}.${payload}`);

  const privateKeyBytes = b64uDecode(vapidPrivate);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    privateKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sigDer = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    cryptoKey,
    sigInput,
  );
  // DER signature → raw r||s (64 bytes)
  const der = new Uint8Array(sigDer);
  const rLen = der[3];
  const r = der.slice(4, 4 + rLen).slice(-32);
  const sOffset = 4 + rLen + 2;
  const sLen = der[sOffset - 1];
  const s = der.slice(sOffset, sOffset + sLen).slice(-32);
  const rawSig = new Uint8Array(64);
  rawSig.set(r, 32 - r.length);
  rawSig.set(s, 64 - s.length);
  const token = `${header}.${payload}.${b64uEncode(rawSig)}`;

  return {
    Authorization: `vapid t=${token},k=${vapidPublic}`,
    "Crypto-Key": `p256ecdsa=${vapidPublic}`,
  };
}

// ── Web Push encryption (RFC 8291 / aes128gcm) ───────────────────────────────

async function encryptPayload(
  payload: string,
  p256dh: string,
  auth: string,
): Promise<{ ciphertext: Uint8Array; salt: Uint8Array; serverPublic: Uint8Array }> {
  const plaintext = new TextEncoder().encode(payload);

  // Generate ephemeral EC key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  const serverPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeyPair.publicKey),
  );

  // Import client public key (p256dh)
  const clientPublicKey = await crypto.subtle.importKey(
    "raw",
    b64uDecode(p256dh),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // ECDH
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientPublicKey },
      serverKeyPair.privateKey,
      256,
    ),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const authBytes = b64uDecode(auth);

  // HKDF PRK: HMAC-SHA256(auth_info || 0x01, ikm)
  const prk = await hkdf(
    authBytes,
    sharedBits,
    concat(
      new TextEncoder().encode("WebPush: info\x00"),
      b64uDecode(p256dh),
      serverPublicRaw,
      new Uint8Array([1]),
    ),
    32,
  );

  // Content encryption key (16 bytes) and nonce (12 bytes)
  const cek = await hkdf(
    salt,
    prk,
    concat(
      new TextEncoder().encode("Content-Encoding: aes128gcm\x00"),
      new Uint8Array([1]),
    ),
    16,
  );
  const nonce = await hkdf(
    salt,
    prk,
    concat(
      new TextEncoder().encode("Content-Encoding: nonce\x00"),
      new Uint8Array([1]),
    ),
    12,
  );

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);

  // Padding: plaintext || 0x02 (delimiter)
  const padded = concat(plaintext, new Uint8Array([2]));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded),
  );

  return { ciphertext: encrypted, salt, serverPublic: serverPublicRaw };
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", key, salt.length ? salt : new Uint8Array(32)));
  const prkKey = await crypto.subtle.importKey(
    "raw",
    prk,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const okm = new Uint8Array(await crypto.subtle.sign("HMAC", prkKey, info));
  return okm.slice(0, length);
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ── Send a single Web Push notification ──────────────────────────────────────

async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: object,
  vapidPublic: string,
  vapidPrivate: string,
): Promise<number> {
  const body = JSON.stringify(payload);
  const { ciphertext, salt, serverPublic } = await encryptPayload(
    body,
    sub.p256dh,
    sub.auth,
  );

  // Build aes128gcm content (RFC 8188):
  // salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext
  const rs = 4096;
  const header = new ArrayBuffer(16 + 4 + 1 + serverPublic.length);
  const dv = new DataView(header);
  new Uint8Array(header).set(salt, 0);
  dv.setUint32(16, rs, false);
  dv.setUint8(20, serverPublic.length);
  new Uint8Array(header).set(serverPublic, 21);

  const content = concat(
    new Uint8Array(header),
    ciphertext,
  );

  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const vapidHeaders = await makeVapidHeaders(audience, vapidPublic, vapidPrivate);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      TTL: "86400",
    },
    body: content,
  });
  return res.status;
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // Bearer トークンで保護
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  if (cronSecret && req.headers.get("Authorization") !== `Bearer ${cronSecret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
  const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return new Response("VAPID keys not configured", { status: 500 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 今日・明日（JST: UTC+9）
  const nowUtc = new Date();
  const jstOffset = 9 * 60 * 60000;
  const nowJst = new Date(nowUtc.getTime() + jstOffset);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const today = fmt(nowJst);
  const tomorrow = fmt(new Date(nowJst.getTime() + 86400000));

  // 全購読を取得
  const { data: subs, error: subErr } = await supabase
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth");
  if (subErr) return new Response(subErr.message, { status: 500 });
  if (!subs?.length) return new Response("No subscribers", { status: 200 });

  const staleIds: string[] = [];
  let sentCount = 0;

  for (const sub of subs) {
    // このユーザーの今日・明日のイベントを取得
    const { data: evs } = await supabase
      .from("events")
      .select("title, date_key, shift_start, time")
      .eq("user_id", sub.user_id)
      .in("date_key", [today, tomorrow]);

    // このユーザーの今日・明日が期限のタスク
    const { data: tasks } = await supabase
      .from("tasks")
      .select("title, due_date")
      .eq("user_id", sub.user_id)
      .eq("done", false)
      .in("due_date", [today, tomorrow]);

    const lines: string[] = [];
    for (const ev of evs ?? []) {
      if (!ev.title) continue;
      const label = ev.date_key === today ? "今日" : "明日";
      const t = ev.shift_start || ev.time;
      lines.push(`📅 ${label} ${t ? t + "〜 " : ""}${ev.title}`);
    }
    for (const task of tasks ?? []) {
      if (!task.title) continue;
      const label = task.due_date === today ? "今日が期限" : "明日が期限";
      lines.push(`📋 「${task.title}」${label}`);
    }
    if (!lines.length) continue;

    const notif = {
      title: "📅 My Calendar",
      body: lines.slice(0, 4).join("\n"),
    };

    try {
      const status = await sendPush(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        notif,
        VAPID_PUBLIC,
        VAPID_PRIVATE,
      );
      if (status === 201 || status === 200) sentCount++;
      else if (status === 410 || status === 404) staleIds.push(sub.id); // 期限切れ
    } catch (_) {
      // ネットワークエラーは無視
    }
  }

  // 期限切れ購読を削除
  if (staleIds.length) {
    await supabase.from("push_subscriptions").delete().in("id", staleIds);
  }

  return new Response(
    JSON.stringify({ sent: sentCount, expired: staleIds.length }),
    { headers: { "Content-Type": "application/json" } },
  );
});
