-- 家計簿エントリの自動取込（JCB メール等）の出所を記録する列と、
-- 二重計上を防ぐための一意制約を追加する。
-- budget_entries はダッシュボードで手動作成されている想定だが、
-- 無い環境でも動くよう CREATE TABLE IF NOT EXISTS を併記する。

create table if not exists budget_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  month_key   text not null,
  entry_id    text not null,
  type        text,
  cat_id      text,
  amount      integer,
  memo        text,
  date        text,
  created_at  timestamptz not null default now()
);

-- 取込元（'jcb' など）と、冪等性のための参照キー
alter table budget_entries add column if not exists source     text;
alter table budget_entries add column if not exists source_ref text;

-- 同じメール（source_ref）の再取込で重複させない
create unique index if not exists budget_entries_source_uniq
  on budget_entries (user_id, source_ref)
  where source_ref is not null;

-- RLS：本人のみ読み書き（既存ポリシーがあれば貼り直し）
alter table budget_entries enable row level security;
drop policy if exists "own budget" on budget_entries;
create policy "own budget" on budget_entries
  for all using (auth.uid() = user_id);
