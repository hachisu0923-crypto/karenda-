# 💳 JCB 利用通知メールを家計簿に自動取込するセットアップ

所要時間：**約 15 分**。設定すると、Gmail に届く JCB の「カードご利用のお知らせ」
メールから **【ご利用金額】の数字を自動で家計簿に登録**します。アプリを開いて
いなくても、15 分ごとに自動でチェックします。

## 全体の流れ

```
Gmail（JCB利用通知）
  → Google Apps Script（あなたのGoogleアカウントで15分ごとに実行）
    → Supabase の取込エンドポイント（金額を正規表現で抽出）
      → 家計簿（budget_entries）に登録
        → カレンダーアプリに自動で表示（💳マーク付き）
```

作業は **Supabase ダッシュボード**（プロジェクト `oungvayvmxkszsokxwxd`）と
**Google Apps Script** の 2 か所です。

---

## ステップ 1：データベースの準備（SQL を 1 回実行）

1. Supabase の **SQL Editor** → **New query**
2. リポジトリの `supabase/migrations/20260610_budget_source.sql` の中身を
   全部貼り付けて **Run**
   （取込元を記録する列と、二重登録を防ぐ索引を追加します。既存データは消えません）

「Success」と出れば OK。

---

## ステップ 2：取込プログラム（Edge Function）を配置

1. Supabase の **Edge Functions** → **Deploy a new function**
2. 関数名を `ingest-jcb` にする
3. エディタの中身を全部消して、リポジトリの
   `supabase/functions/ingest-jcb/index.ts` を全部コピペ
4. **Deploy**

> CLI 派の人は `supabase functions deploy ingest-jcb` でも OK。

---

## ステップ 3：あなたのユーザーIDを確認

1. カレンダーアプリを開いてログイン
2. 家計簿パネルのヘッダーにある **💳ボタン** を押す
3. 表示された **ユーザーID（長い英数字）** をコピー
   （このあと `INGEST_USER_ID` に使います）

---

## ステップ 4：秘密の設定値（Secrets）を 2 つ登録

**Edge Functions → Secrets** で以下を **Add secret**：

| Name | Value |
|---|---|
| `INGEST_SECRET` | 自分で決める長いランダムな文字列（例：パスワード生成で 40 文字くらい） |
| `INGEST_USER_ID` | ステップ 3 でコピーしたユーザーID |

> `INGEST_SECRET` はこのあと Apps Script にも同じ値を設定します。控えておいてください。

---

## ステップ 5：Google Apps Script を設定

1. [script.google.com](https://script.google.com) を開き **新しいプロジェクト**
2. リポジトリの `tools/jcb-gmail-ingest.gs` の中身を全部コピペ
   （`FUNCTION_URL` はこのプロジェクト用に設定済みです）
3. 左メニュー **プロジェクトの設定（⚙）→ スクリプト プロパティ** で
   **プロパティを追加**：
   - プロパティ名：`INGEST_SECRET`
   - 値：ステップ 4 と**同じ値**
4. エディタに戻り、関数 `ingestJcb` を選んで **▶ 実行**
   - 初回は Gmail へのアクセス許可を求められます → 自分のアカウントで許可
   - （「このアプリは確認されていません」と出たら「詳細」→「(プロジェクト名) に移動」で進めます。自分で作ったスクリプトなので安全です）
5. **トリガー（⏰ 時計アイコン）→ トリガーを追加**：
   - 実行する関数：`ingestJcb`
   - イベントのソース：時間主導型
   - 時間ベースのタイマー：**分ベースのタイマー → 15分おき**
   - 保存

これで完了です 🎉

---

## 動作テスト（任意・おすすめ）

Gmail を待たずに、ターミナルから直接テストできます。
`<INGEST_SECRET>` をステップ 4 の値に置き換えて実行：

```bash
curl -X POST \
  -H "Authorization: Bearer <INGEST_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"rawText":"【ご利用日時】2026年6月10日 12:34\n【ご利用金額】1,234円\n【ご利用先】AMAZON.CO.JP","msgId":"test001"}' \
  https://oungvayvmxkszsokxwxd.supabase.co/functions/v1/ingest-jcb
```

- `{"inserted":1,"skipped":0}` が返り、アプリの 6 月家計簿に
  「**AMAZON.CO.JP ¥1,234 💳**」が増えれば成功
- もう一度同じコマンドを実行すると `{"inserted":0,"skipped":1}`
  （同じメールは二重登録されません）

取り込まれたエントリは普通の支出として扱われるので、**タップすればカテゴリを
「食費」などに編集**できます（最初は「その他」になります）。

---

## カスタマイズ

- **検索条件**：`tools/jcb-gmail-ingest.gs` の `query` を変えると、対象メールを
  調整できます（差出人アドレスや件名）。JCB 以外のカード会社メールにも応用可。
- **カテゴリの初期値**：`ingest-jcb/index.ts` の `cat_id: "other_exp"` を変更。

---

## うまくいかないとき

| 症状 | 確認すること |
|---|---|
| curl で `Unauthorized` | `INGEST_SECRET` が Secrets と Apps Script で一致しているか |
| curl で `INGEST_USER_ID not configured` | ステップ 4 で `INGEST_USER_ID` を登録したか |
| `inserted:0` のまま増えない | メール本文に `【ご利用金額】〇〇円` の行があるか（書式が違う場合は query / 正規表現の調整が必要） |
| Apps Script が動かない | トリガーが登録されているか、`INGEST_SECRET` プロパティを設定したか |
| 同じ予定が二重に入った | 通常は起きません（メールIDで重複防止）。もし起きたらアプリ側で片方を削除 |
