-- Homestead Hub Database Schema
-- Run this in your Supabase SQL Editor

-- 1. Master Items Table (all possible items with categories and favorites)
CREATE TABLE IF NOT EXISTS master_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  store_section TEXT NOT NULL,
  is_favorite BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_purchased TIMESTAMPTZ,
  UNIQUE(name, category)
);

-- 2. Shopping List Table (updated)
DROP TABLE IF EXISTS shopping_list CASCADE;
CREATE TABLE shopping_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES master_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  store_section TEXT NOT NULL,
  quantity INTEGER,
  checked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_master_items_category ON master_items(category);
CREATE INDEX idx_master_items_favorite ON master_items(is_favorite);
CREATE INDEX idx_master_items_store ON master_items(store_section);
CREATE INDEX idx_shopping_section ON shopping_list(store_section);
CREATE INDEX idx_shopping_checked ON shopping_list(checked);

-- Enable Row Level Security
ALTER TABLE master_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_list ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Enable all access for master_items" ON master_items
  FOR ALL TO public USING (true) WITH CHECK (true);

CREATE POLICY "Enable all access for shopping_list" ON shopping_list
  FOR ALL TO public USING (true) WITH CHECK (true);

-- 3. Seed Data - Common Items
-- BJs Items
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Paper Towels', 'supplies-cleaning', 'bjs', true),
  ('Toilet Paper', 'supplies-bathroom', 'bjs', true),
  ('Aluminum Foil', 'supplies-kitchen', 'bjs', true),
  ('Parchment Paper', 'supplies-kitchen', 'bjs', true),
  ('Trash Bags', 'supplies-cleaning', 'bjs', true),
  ('Cookies', 'basement-other', 'bjs', true),
  ('Coffee', 'pantry-other', 'bjs', true),
  ('Ice Cream', 'upstairs-freezer', 'bjs', true);

-- Produce
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Lettuce', 'fridge-vegetables', 'produce', false),
  ('Carrots', 'fridge-vegetables', 'produce', false),
  ('Onions', 'fridge-vegetables', 'produce', false),
  ('Potatoes', 'fridge-vegetables', 'produce', false),
  ('Tomatoes', 'fridge-vegetables', 'produce', false);

-- Bakery
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Bread', 'pantry-other', 'bakery', true),
  ('Bagels', 'pantry-other', 'bakery', false),
  ('Rolls', 'pantry-other', 'bakery', false);

-- Condiments
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Ketchup', 'pantry-condiments', 'condiments', false),
  ('Mustard', 'pantry-condiments', 'condiments', false),
  ('Mayonnaise', 'pantry-condiments', 'condiments', false),
  ('Hot Sauce', 'pantry-condiments', 'condiments', false);

-- Tortillas
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Flour Tortillas', 'fridge-cheese-tortillas', 'tortillas', true),
  ('Corn Tortillas', 'fridge-cheese-tortillas', 'tortillas', false);

-- Tomatoes/Pasta/Beans
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Canned Tomatoes', 'pantry-tomatoes', 'pasta-beans', true),
  ('Pasta Sauce', 'pantry-tomatoes', 'pasta-beans', true),
  ('Spaghetti', 'pantry-grains', 'pasta-beans', true),
  ('Penne Pasta', 'pantry-grains', 'pasta-beans', false),
  ('Black Beans - Large', 'pantry-beans', 'pasta-beans', true),
  ('Black Beans - Small', 'pantry-beans', 'pasta-beans', true),
  ('Kidney Beans', 'pantry-beans', 'pasta-beans', false),
  ('Pinto Beans', 'pantry-beans', 'pasta-beans', false);

-- Canned Goods
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Corn', 'pantry-canned', 'canned', false),
  ('Green Beans', 'pantry-canned', 'canned', false),
  ('Soup', 'pantry-canned', 'canned', false);

-- Cooking Liquids
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Chicken Broth', 'pantry-liquids', 'liquids', true),
  ('Beef Broth', 'pantry-liquids', 'liquids', false),
  ('Vegetable Oil', 'pantry-liquids', 'liquids', true),
  ('Olive Oil', 'pantry-liquids', 'liquids', false),
  ('Vinegar', 'pantry-liquids', 'liquids', false);

-- Baking
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Flour', 'pantry-baking', 'baking', true),
  ('Sugar', 'pantry-baking', 'baking', true),
  ('Brown Sugar', 'pantry-baking', 'baking', false),
  ('Baking Powder', 'pantry-baking', 'baking', false),
  ('Baking Soda', 'pantry-baking', 'baking', false),
  ('Vanilla Extract', 'pantry-baking', 'baking', false),
  ('Salt', 'pantry-baking', 'baking', true),
  ('Pepper', 'pantry-baking', 'baking', true);

-- Store Meat
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Ground Beef', 'basement-store-meat', 'meat', false),
  ('Chicken Breasts', 'basement-store-meat', 'meat', false),
  ('Pork Chops', 'basement-store-meat', 'meat', false),
  ('Bacon', 'basement-store-meat', 'meat', false);

-- Dairy
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Milk', 'fridge-other', 'dairy', true),
  ('Eggs', 'fridge-other', 'dairy', true),
  ('Butter', 'fridge-other', 'dairy', true),
  ('Cheese - Cheddar', 'fridge-cheese-tortillas', 'dairy', true),
  ('Cheese - Mozzarella', 'fridge-cheese-tortillas', 'dairy', false),
  ('Jacob Cheese', 'fridge-kids-drawer', 'dairy', true),
  ('Tina Cheese', 'fridge-kids-drawer', 'dairy', true),
  ('Yogurt Packets', 'fridge-kids-drawer', 'dairy', true),
  ('Cheese Sticks', 'fridge-kids-drawer', 'dairy', true),
  ('Deli Chicken', 'fridge-kids-drawer', 'dairy', false),
  ('Sour Cream', 'fridge-other', 'dairy', false),
  ('Cream Cheese', 'fridge-other', 'dairy', false);

-- Frozen
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Frozen Vegetables', 'upstairs-freezer', 'frozen', false),
  ('Frozen Pizza', 'upstairs-freezer', 'frozen', false),
  ('Frozen Fruit', 'upstairs-freezer', 'frozen', false);

-- Juice & Milk
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Orange Juice', 'fridge-other', 'juice', true),
  ('Apple Juice', 'fridge-other', 'juice', false);

-- Chips/Snacks
INSERT INTO master_items (name, category, store_section, is_favorite) VALUES
  ('Potato Chips', 'pantry-snacks', 'snacks', false),
  ('Tortilla Chips', 'pantry-snacks', 'snacks', false),
  ('Pretzels', 'pantry-snacks', 'snacks', false),
  ('Applesauce Packets', 'pantry-kids-snacks', 'snacks', true),
  ('Granola Bars', 'pantry-kids-snacks', 'snacks', true);

-- Success message
SELECT 'Database setup complete! Master items table created with seed data.' as message;
