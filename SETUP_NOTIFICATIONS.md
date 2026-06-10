# 📲 通知セットアップガイド（アプリを閉じていても通知が届くようにする）

所要時間：**約 10 分**。全部やると、アプリを完全に閉じていても

- 毎朝 8 時に「今日・明日の予定とタスク」のお知らせ
- 予定に設定した「X分前」のリマインダー

がスマホのロック画面に届くようになります。

作業はすべて [Supabase ダッシュボード](https://supabase.com/dashboard) 上で行います。
このプロジェクト（`oungvayvmxkszsokxwxd`）を開いてから進めてください。

---

## ステップ 1：データベースの準備（SQL を 1 回実行）

1. 左メニューの **SQL Editor** を開く
2. **New query** を押して、下の SQL を**全部まるごと**貼り付けて **Run**

```sql
-- 通知の購読情報を保存するテーブル（作成済みならスキップされます）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, endpoint)
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own subscriptions" ON push_subscriptions;
CREATE POLICY "own subscriptions" ON push_subscriptions
  FOR ALL USING (auth.uid() = user_id);

-- 予定の「X分前通知」用カラム
ALTER TABLE events ADD COLUMN IF NOT EXISTS reminder_minutes integer;

-- 定期実行に必要な拡張機能
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
```

「Success」と出れば OK。
（拡張機能でエラーが出た場合は、左メニュー **Database → Extensions** で `pg_cron` と `pg_net` を検索してスイッチを ON にしてください）

---

## ステップ 2：通知送信プログラム（Edge Function）を配置

1. 左メニューの **Edge Functions** を開く
2. **Deploy a new function**（または Create function）を押す
3. 関数名を `push-notify` にする
4. エディタが開いたら、中身を**全部消して**、このリポジトリの
   `supabase/functions/push-notify/index.ts` の中身を**全部コピペ**する
5. **Deploy** を押す

> パソコンに Supabase CLI がある場合は、リポジトリのフォルダで
> `supabase functions deploy push-notify` でも OK です。

---

## ステップ 3：秘密の設定値（Secrets）を 3 つ登録

1. **Edge Functions → Secrets**（または Settings → Edge Functions）を開く
2. 以下の 3 つを **Add secret** で登録（名前は正確に！）

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | `BHHdWaRp_PkaJ49UF_c7pW7deXy79CtIx8K3SZ-gK18i7C-PjbYuBqhdEDzI7lUwp0NfSIqUEMPs5ra9IE4fiQg` |
| `VAPID_PRIVATE_KEY` | （チャットで渡された秘密鍵。**このファイルには書かない**） |
| `CRON_SECRET` | （チャットで渡されたランダム文字列。自分で決めた長い文字列でも OK） |

> `VAPID_PUBLIC_KEY` は app.js に入っている値と同じである必要があります。
> 鍵を作り直したいときは `npx web-push generate-vapid-keys` で生成し、
> 公開鍵を app.js の `VAPID_PUBLIC_KEY` にも貼り直してください。

---

## ステップ 4：自動実行のスケジュール（cron）を 2 本登録

**SQL Editor** に戻り、下の SQL の `ここにCRON_SECRET` を
ステップ 3 で登録した CRON_SECRET に置き換えて Run（2 か所あります）。

```sql
-- ① 毎朝 8 時（日本時間）のお知らせ便
SELECT cron.schedule(
  'push-notify-daily',
  '0 23 * * *',
  $$
  SELECT net.http_post(
    url := 'https://oungvayvmxkszsokxwxd.supabase.co/functions/v1/push-notify',
    headers := '{"Authorization":"Bearer ここにCRON_SECRET","Content-Type":"application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);

-- ② 5 分おきの「X分前リマインダー」便
SELECT cron.schedule(
  'push-notify-reminders',
  '0,5,10,15,20,25,30,35,40,45,50,55 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://oungvayvmxkszsokxwxd.supabase.co/functions/v1/push-notify',
    headers := '{"Authorization":"Bearer ここにCRON_SECRET","Content-Type":"application/json"}'::jsonb,
    body := '{"mode":"reminders"}'::jsonb
  );
  $$
);
```

---

## ステップ 5：スマホ側の設定（各端末で 1 回だけ）

### Android（Chrome）
1. カレンダーのサイトを開く
2. サイドバー下の **「🔔 通知を有効にする」** をタップ
3. 「許可」を選ぶ → テスト通知が出れば完了 🎉

### iPhone / iPad（iOS 16.4 以上）
1. **Safari** でカレンダーのサイトを開く
2. 下の **共有ボタン（□↑）→「ホーム画面に追加」**
3. ホーム画面にできた**アイコンから**アプリを開く
4. サイドバー下の **「🔔 通知を有効にする」** をタップ →「許可」
5. テスト通知が出れば完了 🎉

> iPhone は Apple の仕様で、**ホーム画面に追加したアプリからでないと**
> 通知を受け取れません。Safari のまま開いてもボタンを押すと手順案内が出ます。

---

## 動作テスト（任意）

スマホでアプリを完全に閉じた状態で、パソコンのターミナルから：

```bash
curl -X POST \
  -H "Authorization: Bearer ここにCRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{}' \
  https://oungvayvmxkszsokxwxd.supabase.co/functions/v1/push-notify
```

今日か明日に予定がある場合、数秒でスマホに通知が届きます。
（`{"sent":1,...}` のような応答が返れば送信成功）

---

## うまくいかないとき

| 症状 | 確認すること |
|---|---|
| 🔔ボタンを押しても何も起きない | iPhone の場合：ホーム画面に追加したアイコンから開いているか |
| テスト通知は出るが朝の通知が来ない | ステップ 4 の cron が登録できているか（SQL Editor で `SELECT * FROM cron.job;`） |
| curl で `Unauthorized` | CRON_SECRET が Secrets の値と一致しているか |
| curl で `VAPID keys not configured` | ステップ 3 の Secrets 3 つが登録されているか |
| 通知が来なくなった | アプリを開き直して 🔔ボタンを再タップ（購読の更新） |
