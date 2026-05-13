-- Run this on the local PostgreSQL to add all finance tables.
-- Connect: psql -h localhost -U homestead -d homestead

CREATE TABLE IF NOT EXISTS finance_accounts (
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

-- Add account_id to finance_transactions if it doesn't exist
DO $$ BEGIN
    ALTER TABLE finance_transactions ADD COLUMN account_id UUID REFERENCES finance_accounts(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS finance_bills (
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

CREATE TABLE IF NOT EXISTS finance_bill_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bill_id UUID REFERENCES finance_bills(id),
    bill_month TEXT,
    actual_amount NUMERIC,
    is_paid BOOLEAN DEFAULT false,
    paid_date DATE,
    week_assigned TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_weekly_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date DATE,
    account_id UUID REFERENCES finance_accounts(id),
    ending_balance NUMERIC DEFAULT 0,
    bill_payment NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_loan_schedules (
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

CREATE TABLE IF NOT EXISTS finance_other_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date DATE,
    description TEXT,
    amount NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_extra_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_date DATE,
    account_id UUID REFERENCES finance_accounts(id),
    amount NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS finance_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
