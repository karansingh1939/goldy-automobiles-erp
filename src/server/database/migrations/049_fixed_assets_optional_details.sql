-- Workshop equipment: code, supplier and invoice number become optional (old
-- tools often have none), and each purchase records which money paid for it
-- so Cash, Bank and the Balance Sheet stay right. Nothing references
-- fixed_assets, so the table is rebuilt in place.
PRAGMA foreign_keys = OFF;

CREATE TABLE fixed_assets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_name TEXT NOT NULL,
  sku TEXT UNIQUE,
  category TEXT NOT NULL DEFAULT 'Equipment',
  supplier_id INTEGER REFERENCES suppliers(id),
  invoice_number TEXT,
  purchase_date TEXT NOT NULL,
  purchase_cost REAL NOT NULL CHECK (purchase_cost >= 0),
  gst_amount REAL NOT NULL DEFAULT 0 CHECK (gst_amount >= 0),
  serial_number TEXT,
  warranty_info TEXT,
  notes TEXT,
  paid_from TEXT NOT NULL DEFAULT 'EARLIER' CHECK (paid_from IN ('CASH', 'BANK', 'EARLIER')),
  voucher_id INTEGER REFERENCES vouchers(id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Equipment registered before this update never touched the accounts, so it
-- is kept as "bought earlier" with no money entry.
INSERT INTO fixed_assets_new (
  id, asset_name, sku, category, supplier_id, invoice_number, purchase_date,
  purchase_cost, gst_amount, serial_number, warranty_info, notes, created_by,
  created_at, updated_at
)
SELECT
  id, asset_name, sku, category, supplier_id, invoice_number, purchase_date,
  purchase_cost, gst_amount, serial_number, warranty_info, notes, created_by,
  created_at, updated_at
FROM fixed_assets;

DROP TABLE fixed_assets;
ALTER TABLE fixed_assets_new RENAME TO fixed_assets;

PRAGMA foreign_keys = ON;
