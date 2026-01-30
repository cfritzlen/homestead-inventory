-- Shopping List Table Setup
-- Run this in your Supabase SQL Editor

CREATE TABLE shopping_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER,
  checked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create an index for faster queries
CREATE INDEX idx_shopping_category ON shopping_list(category);
CREATE INDEX idx_shopping_checked ON shopping_list(checked);

-- Enable Row Level Security
ALTER TABLE shopping_list ENABLE ROW LEVEL SECURITY;

-- Create policy
CREATE POLICY "Enable all access for everyone" ON shopping_list
  FOR ALL
  TO public
  USING (true)
  WITH CHECK (true);
