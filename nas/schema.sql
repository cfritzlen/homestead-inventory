-- Homestead Hub — PostgreSQL Schema
-- Migrated from Supabase

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- SOLAR
-- ============================================================

CREATE TABLE solar_readings (
    reading_date DATE NOT NULL,
    reading_time TEXT NOT NULL,
    pv_watts NUMERIC DEFAULT 0,
    battery_watts NUMERIC DEFAULT 0,
    battery_soc NUMERIC DEFAULT 0,
    grid_watts NUMERIC DEFAULT 0,
    load_watts NUMERIC DEFAULT 0,
    PRIMARY KEY (reading_date, reading_time)
);

CREATE TABLE solar_daily_summary (
    summary_date DATE PRIMARY KEY,
    pv_kwh NUMERIC DEFAULT 0,
    battery_charge_kwh NUMERIC DEFAULT 0,
    battery_discharge_kwh NUMERIC DEFAULT 0,
    grid_import_kwh NUMERIC DEFAULT 0,
    grid_export_kwh NUMERIC DEFAULT 0,
    load_kwh NUMERIC DEFAULT 0,
    peak_pv_watts NUMERIC DEFAULT 0,
    peak_load_watts NUMERIC DEFAULT 0
);

CREATE TABLE solar_realtime (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pv_watts NUMERIC DEFAULT 0,
    battery_watts NUMERIC DEFAULT 0,
    battery_soc NUMERIC DEFAULT 0,
    grid_watts NUMERIC DEFAULT 0,
    load_watts NUMERIC DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE solar_electric_bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number TEXT UNIQUE,
    bill_date DATE,
    kwh_produced NUMERIC,
    kwh_consumed NUMERIC,
    bill_amount NUMERIC,
    pdf_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- HEALTH (Martin & Kids)
-- ============================================================

CREATE TABLE meds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT DEFAULT 'maintenance',
    morning BOOLEAN DEFAULT FALSE,
    night BOOLEAN DEFAULT FALSE,
    times JSONB,
    start_date DATE,
    end_date DATE,
    default_puffs INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE med_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person TEXT NOT NULL,
    med_name TEXT NOT NULL,
    taken_at TIMESTAMPTZ NOT NULL,
    puffs INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bp_readings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person TEXT NOT NULL,
    reading_datetime TIMESTAMPTZ NOT NULL,
    systolic INTEGER,
    diastolic INTEGER,
    pulse INTEGER,
    symptoms TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE med_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person TEXT NOT NULL,
    note_date DATE,
    type TEXT DEFAULT 'general',
    title TEXT,
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sleep_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person TEXT NOT NULL DEFAULT 'martin',
    sleep_date DATE,
    start_time TIME,
    end_time TIME,
    quality_rating INTEGER,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- RECIPES & MEAL PLANNING
-- ============================================================

CREATE TABLE recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    protein_category TEXT,
    min_days_between INTEGER,
    notes TEXT,
    rating INTEGER,
    last_cooked_date DATE,
    planned_cook_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE master_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    is_favorite BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE recipe_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    ingredient_name TEXT,
    quantity TEXT,
    master_item_id UUID REFERENCES master_items(id),
    is_section BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE recipe_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    step_number INTEGER,
    instruction TEXT,
    is_section BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE meal_plan (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_id UUID REFERENCES recipes(id),
    date DATE,
    display_order INTEGER,
    is_cooked BOOLEAN DEFAULT FALSE
);

-- ============================================================
-- SHOPPING & INVENTORY
-- ============================================================

CREATE TABLE shopping_list (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity INTEGER,
    checked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE inventory (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    quantity NUMERIC,
    category TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- EXPENSES & FINANCES
-- ============================================================

CREATE TABLE home_vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE home_expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_date DATE,
    category TEXT,
    vendor_id UUID REFERENCES home_vendors(id),
    amount NUMERIC,
    description TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE home_expense_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID REFERENCES home_expenses(id) ON DELETE CASCADE,
    receipt_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    account_type TEXT DEFAULT 'other',
    interest_rate NUMERIC DEFAULT 0,
    starting_balance NUMERIC DEFAULT 0,
    min_payment NUMERIC DEFAULT 0,
    is_debt BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    pays_from TEXT,
    last_4 TEXT,
    notes TEXT,
    display_order INTEGER DEFAULT 0,
    closed_date DATE,
    closed_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES finance_accounts(id),
    dedup_hash TEXT UNIQUE,
    transaction_date DATE,
    description TEXT,
    amount NUMERIC,
    category TEXT,
    source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    expected_amount NUMERIC DEFAULT 0,
    is_variable_amount BOOLEAN DEFAULT false,
    due_day INTEGER,
    is_variable_date BOOLEAN DEFAULT false,
    is_auto_pay BOOLEAN DEFAULT false,
    frequency TEXT DEFAULT 'monthly',
    pays_from TEXT,
    category TEXT DEFAULT 'other',
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_bill_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID REFERENCES finance_bills(id),
    bill_month TEXT,
    actual_amount NUMERIC,
    is_paid BOOLEAN DEFAULT false,
    paid_date DATE,
    week_assigned TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_weekly_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date DATE,
    account_id UUID REFERENCES finance_accounts(id),
    ending_balance NUMERIC DEFAULT 0,
    bill_payment NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_loan_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES finance_accounts(id),
    payment_number INTEGER,
    due_date DATE,
    payment_amount NUMERIC,
    principal NUMERIC,
    interest NUMERIC,
    balance_after NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_other_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date DATE,
    description TEXT,
    amount NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_extra_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date DATE,
    account_id UUID REFERENCES finance_accounts(id),
    amount NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE finance_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- HOMESTEAD
-- ============================================================

CREATE TABLE hatching_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    year INTEGER,
    bird_type TEXT,
    status TEXT DEFAULT 'Planned',
    set_date DATE,
    qty_set INTEGER,
    qty_hatched INTEGER,
    qty_brooder_exit INTEGER,
    qty_harvested INTEGER,
    harvest_date_actual DATE,
    hatch_days INTEGER,
    notes TEXT
);

CREATE TABLE homestead_chores (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    year INTEGER,
    task TEXT,
    category TEXT,
    subcategory TEXT,
    due_date DATE,
    completion_date DATE,
    completed BOOLEAN DEFAULT FALSE,
    notes TEXT
);

CREATE TABLE plant_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    year INTEGER,
    plant_type TEXT,
    variety TEXT,
    grow_method TEXT,
    planned_count INTEGER,
    seeds_sowed INTEGER,
    plant_count INTEGER,
    survival_count INTEGER,
    suggested_sow_date DATE,
    actual_sow_date DATE,
    suggested_direct_sow_date DATE,
    sow_date DATE,
    germination_date DATE,
    potup_date DATE,
    thinning_date DATE,
    greenhouse_window_start DATE,
    greenhouse_window_end DATE,
    hardening_date DATE,
    transplant_outdoor_date DATE,
    garden_location TEXT,
    general_notes TEXT,
    pest_notes TEXT
);

CREATE TABLE plant_photos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_entry_id UUID REFERENCES plant_entries(id) ON DELETE CASCADE,
    stage TEXT,
    photo_url TEXT,
    taken_date DATE
);

CREATE TABLE harvest_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plant_entry_id UUID REFERENCES plant_entries(id) ON DELETE CASCADE,
    harvest_date DATE,
    amount NUMERIC,
    unit TEXT,
    notes TEXT
);

-- ============================================================
-- OPEN BRAIN (Knowledge Base)
-- ============================================================

CREATE TABLE brain_topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT UNIQUE,
    sort_order INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brain_people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brain_tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brain_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name TEXT,
    file_type TEXT,
    file_path TEXT,
    file_size_bytes INTEGER,
    source TEXT,
    tags JSONB,
    related_person TEXT,
    event_date DATE,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE brain_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content TEXT,
    source TEXT,
    tags JSONB,
    related_people JSONB,
    event_date DATE,
    document_id UUID REFERENCES brain_documents(id),
    is_private BOOLEAN DEFAULT FALSE,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- PREDICTIONS
-- ============================================================

CREATE TABLE prediction_trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform TEXT,
    ticker TEXT,
    title TEXT,
    side TEXT,
    price NUMERIC,
    contracts INTEGER,
    status TEXT,
    order_id TEXT,
    ai_reasoning TEXT,
    profit_loss NUMERIC DEFAULT 0,
    closes_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    total_cost NUMERIC,
    payout_if_win NUMERIC,
    payout_if_lose NUMERIC DEFAULT 0,
    current_price NUMERIC,
    cost NUMERIC,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_solar_readings_date ON solar_readings(reading_date);
CREATE INDEX idx_bp_readings_person ON bp_readings(person);
CREATE INDEX idx_bp_readings_datetime ON bp_readings(reading_datetime);
CREATE INDEX idx_meds_person ON meds(person);
CREATE INDEX idx_med_logs_person ON med_logs(person);
CREATE INDEX idx_med_notes_person ON med_notes(person);
CREATE INDEX idx_sleep_person ON sleep_entries(person);
CREATE INDEX idx_expenses_date ON home_expenses(expense_date);
CREATE INDEX idx_expenses_category ON home_expenses(category);
CREATE INDEX idx_hatching_year ON hatching_batches(year);
CREATE INDEX idx_chores_year ON homestead_chores(year);
CREATE INDEX idx_plants_year ON plant_entries(year);
CREATE INDEX idx_recipes_category ON recipes(protein_category);
CREATE INDEX idx_meal_plan_date ON meal_plan(date);
CREATE INDEX idx_brain_memories_source ON brain_memories(source);
