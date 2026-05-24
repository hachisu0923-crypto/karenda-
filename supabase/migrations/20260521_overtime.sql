-- 残業（overtime）機能のためのスキーマ変更
-- 1) events テーブルに overtime_minutes カラムを追加
--    シフトイベントに「残業分」を持たせる。バンク（per category）に累積される。
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS overtime_minutes integer NOT NULL DEFAULT 0;

-- 2) overtime_cashouts: バンクから給料へキャッシュアウトした履歴
CREATE TABLE IF NOT EXISTS overtime_cashouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cat_id      integer NOT NULL,
  minutes     integer NOT NULL CHECK (minutes > 0),
  note        text DEFAULT '',
  date_key    text NOT NULL,            -- 給料に計上される対象月の日付（YYYY-MM-DD）
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS overtime_cashouts_user_date_idx
  ON overtime_cashouts (user_id, date_key);

ALTER TABLE overtime_cashouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own cashouts" ON overtime_cashouts
  FOR ALL USING (auth.uid() = user_id);
