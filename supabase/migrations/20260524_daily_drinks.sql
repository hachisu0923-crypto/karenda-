-- 一日の飲酒カウンター: 日付ごとの「飲んだ数」を user_id + date_key で保持
CREATE TABLE IF NOT EXISTS daily_drinks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date_key    text NOT NULL,            -- YYYY-MM-DD
  count       integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, date_key)
);

CREATE INDEX IF NOT EXISTS daily_drinks_user_date_idx
  ON daily_drinks (user_id, date_key);

ALTER TABLE daily_drinks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own drinks" ON daily_drinks
  FOR ALL USING (auth.uid() = user_id);
