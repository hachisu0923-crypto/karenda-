/**
 * ingest-jcb Edge Function
 *
 * JCB「カードご利用のお知らせ」メール本文を受け取り、【ご利用金額】を
 * 正規表現で抽出して budget_entries に登録する。
 *
 * 呼び出し元：Google Apps Script（tools/jcb-gmail-ingest.gs）が Gmail を
 * 定期検索し、本文を POST する。
 *
 * セットアップ手順は SETUP_JCB_INGEST.md を参照。
 *
 * 必要な Secrets（Supabase ダッシュボード > Edge Functions > Secrets）:
 *   INGEST_SECRET   = Apps Script と共有する任意の長いランダム文字列
 *   INGEST_USER_ID  = 取り込み先の Supabase ユーザー UUID（アプリの💳設定で確認）
 * （SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は自動で注入される）
 */

import { createClient } from "npm:@supabase/supabase-js@2";

// 全角英数記号 → 半角に正規化（１，２３４円 → 1,234円 など）
function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/，/g, ",")
    .replace(/　/g, " ");   // 全角スペース
}

interface Parsed {
  amount: number;
  memo: string;
  date: string;   // YYYY-MM-DD
}

// メール本文から（金額・利用先・日付）の明細を抽出。複数明細にも対応。
function parseJcbEmail(rawText: string, fallbackDate: string): Parsed[] {
  const text = toHalfWidth(rawText || "");

  // 利用先（最初の1件を共通memoに）
  let merchant = "";
  const mMerchant = text.match(/【ご利用先[^】]*】\s*(.+)/);
  if (mMerchant) merchant = mMerchant[1].trim();

  // 日時（最初の1件を共通dateに）。"2026年6月10日" / "2026/06/10" / "2026-06-10"
  let date = fallbackDate;
  const mDate = text.match(/【ご利用日時[^】]*】\s*([0-9]{4})[年/\-.]\s*([0-9]{1,2})[月/\-.]\s*([0-9]{1,2})/);
  if (mDate) {
    const y = mDate[1];
    const mo = String(mDate[2]).padStart(2, "0");
    const d = String(mDate[3]).padStart(2, "0");
    date = `${y}-${mo}-${d}`;
  }

  // 金額（複数の【ご利用金額】に対応：global）
  const out: Parsed[] = [];
  const re = /【ご利用金額[^】]*】\s*([\d,]+)\s*円/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const amount = parseInt(m[1].replace(/,/g, ""), 10);
    if (!amount || amount <= 0) continue;
    out.push({ amount, memo: merchant, date });
  }
  return out;
}

Deno.serve(async (req) => {
  // Bearer トークンで保護
  const secret = Deno.env.get("INGEST_SECRET") ?? "";
  if (!secret || req.headers.get("Authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = Deno.env.get("INGEST_USER_ID") ?? "";
  if (!userId) {
    return new Response("INGEST_USER_ID not configured", { status: 500 });
  }

  let body: { rawText?: string; msgId?: string; date?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const rawText = body.rawText ?? "";
  const msgId = (body.msgId ?? `m${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  // フォールバック日付（メール受信日 or 実行日）
  const todayJst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const fallbackDate = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) ? body.date : todayJst;

  const parsed = parseJcbEmail(rawText, fallbackDate);
  if (!parsed.length) {
    return new Response(JSON.stringify({ inserted: 0, skipped: 0, note: "no amount found" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const rows = parsed.map((p, idx) => ({
    user_id: userId,
    month_key: p.date.slice(0, 7),
    entry_id: `jcb_${msgId}_${idx}`,
    type: "expense",
    cat_id: "other_exp",
    amount: p.amount,
    memo: p.memo || "JCB利用",
    date: p.date,
    source: "jcb",
    source_ref: `${msgId}#${idx}`,
  }));

  // (user_id, source_ref) UNIQUE により再送は無視 → 二重計上を防ぐ
  const { data, error } = await supabase
    .from("budget_entries")
    .upsert(rows, { onConflict: "user_id,source_ref", ignoreDuplicates: true })
    .select("id");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const inserted = data?.length ?? 0;
  return new Response(
    JSON.stringify({ inserted, skipped: rows.length - inserted }),
    { headers: { "Content-Type": "application/json" } },
  );
});
