/**
 * JCB 利用通知メール → 家計簿 自動取込（Google Apps Script）
 *
 * これは Google Apps Script（script.google.com）に貼り付けて使うコードです。
 * このリポジトリには参考用に置いてあります。セットアップ手順は
 * SETUP_JCB_INGEST.md を参照してください。
 *
 * 仕組み：Gmail から JCB の利用通知メールを定期検索し、本文を Supabase の
 * ingest-jcb Edge Function に POST する。成功したスレッドには
 * 「jcb-imported」ラベルを付けて次回以降スキップする。
 *
 * 事前準備：
 *   1. プロジェクトの設定 > スクリプトプロパティに INGEST_SECRET を登録
 *      （Edge Function の Secret と同じ値）
 *   2. ingestJcb を一度手動実行して Gmail へのアクセスを許可
 *   3. トリガー（時計アイコン）で ingestJcb を 15 分間隔の時間主導に設定
 */

var FUNCTION_URL = 'https://oungvayvmxkszsokxwxd.supabase.co/functions/v1/ingest-jcb';

function ingestJcb() {
  var secret = PropertiesService.getScriptProperties().getProperty('INGEST_SECRET');
  if (!secret) throw new Error('スクリプトプロパティ INGEST_SECRET が未設定です');

  var label = GmailApp.getUserLabelByName('jcb-imported') || GmailApp.createLabel('jcb-imported');

  // JCB の利用通知を検索（未取込・30日以内）。差出人や件名は環境に合わせて調整可。
  var query = 'from:(jcb.co.jp) (subject:(利用のお知らせ) OR subject:(ご利用)) -label:jcb-imported newer_than:30d';
  var threads = GmailApp.search(query, 0, 20);

  threads.forEach(function (th) {
    var ok = true;
    th.getMessages().forEach(function (m) {
      var payload = {
        rawText: m.getPlainBody(),
        msgId: m.getId(),
        date: Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd')
      };
      var res = UrlFetchApp.fetch(FUNCTION_URL, {
        method: 'post',
        contentType: 'application/json',
        muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + secret },
        payload: JSON.stringify(payload)
      });
      if (res.getResponseCode() >= 300) {
        ok = false;
        Logger.log('ingest failed: ' + res.getResponseCode() + ' ' + res.getContentText());
      }
    });
    // 全メッセージ成功時のみラベル付け＝次回スキップ。失敗時は次回再試行。
    if (ok) th.addLabel(label);
  });
}
