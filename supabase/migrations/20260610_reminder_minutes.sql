-- 予定ごとの「X分前に通知」設定。null = 通知なし
alter table events add column if not exists reminder_minutes integer;
