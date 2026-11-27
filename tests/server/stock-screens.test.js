import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { InventoryService } from '../../src/server/modules/inventory/inventory.service.js';
import { MoneyService } from '../../src/server/modules/accounting/money.service.js';

const stockLedger = (db) =>
  db
    .prepare(
      `SELECT ROUND(COALESCE(SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE -je.amount END), 0), 2) AS value
       FROM journal_entries je JOIN ledgers l ON l.id = je.ledger_id JOIN vouchers v ON v.id = je.voucher_id
       WHERE l.system_key = 'inventory_stock' AND v.status != 'CANCELLED'`,
    )
    .get().value;

test('bulk opening counts move stock and its accounting value together', async () => {
  const context = await createTestContext();
  try {
    const inventory = new InventoryService(context.db);
    const item = inventory.createItem(
      { sku: 'BULK-1', item_name: 'Bulk counted filter', purchase_cost: 100, selling_price: 150 },
      1,
    );
    inventory.bulkSave({ items: [{ itemId: item.id, quantity: 5, unitCost: 100 }] }, 1);
    assert.equal(inventory.getItem(item.id).current_quantity, 5);
    assert.equal(stockLedger(context.db), 500);

    inventory.bulkSave({ items: [{ itemId: item.id, quantity: 3 }] }, 1);
    assert.equal(inventory.getItem(item.id).current_quantity, 3);
    assert.equal(stockLedger(context.db), 300);

    assert.throws(() => inventory.bulkSave({ items: [] }, 1), /At least one item/);
  } finally {
    await context.close();
  }
});

test('a stock count can be rejected without changing stock', async () => {
  const context = await createTestContext();
  try {
    const inventory = new InventoryService(context.db);
    const item = inventory.createItem(
      { sku: 'COUNT-1', item_name: 'Counted part', purchase_cost: 50, selling_price: 80 },
      1,
    );
    inventory.createOpeningStock(
      { item_id: item.id, warehouse_id: 1, quantity: 4, unit_cost: 50 },
      1,
    );
    const result = inventory.verifyStock(
      { warehouse_id: 1, item_id: item.id, counted_quantity: 2, verification_type: 'Single Item' },
      1,
    );
    const id = context.db
      .prepare('SELECT id FROM stock_verifications WHERE verification_number = ?')
      .get(result.items[0].verification_number).id;
    const rejected = inventory.rejectVerification(id, 1);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(inventory.getItem(item.id).current_quantity, 4);
  } finally {
    await context.close();
  }
});

test('workshop equipment is registered as a fixed asset, not stock', async () => {
  const context = await createTestContext();
  try {
    const supplier = context.db
      .prepare("INSERT INTO suppliers (name) VALUES ('Equipment Supplier')")
      .run().lastInsertRowid;
    const inventory = new InventoryService(context.db);
    assert.throws(() => inventory.createFixedAsset({ asset_name: 'No details' }, 1), /required/);
    inventory.createFixedAsset(
      {
        asset_name: 'Air compressor',
        sku: 'ast-1',
        supplier_id: supplier,
        invoice_number: 'EQ-1',
        purchase_date: '2026-11-20',
        purchase_cost: 25000,
      },
      1,
    );
    const listed = inventory.listFixedAssets({});
    assert.equal(listed.data[0].asset_name, 'Air compressor');
    assert.equal(listed.data[0].sku, 'AST-1');
    assert.equal(
      context.db.prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE sku = 'AST-1'").get().n,
      0,
    );
  } finally {
    await context.close();
  }
});

test('equipment needs only name, date and price, and moves cash or capital', async () => {
  const context = await createTestContext();
  try {
    const inventory = new InventoryService(context.db);
    const money = new MoneyService(context.db);
    const cash = () => money.listAccounts().find((a) => a.kind === 'CASH').balance;
    const ledger = (key) =>
      context.db
        .prepare(
          `SELECT ROUND(COALESCE(SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE -je.amount END), 0), 2) AS value
           FROM journal_entries je JOIN ledgers l ON l.id = je.ledger_id JOIN vouchers v ON v.id = je.voucher_id
           WHERE l.system_key = ? AND v.status != 'CANCELLED'`,
        )
        .get(key).value;
    const before = cash();

    const jack = inventory.createFixedAsset(
      {
        asset_name: 'Floor jack',
        purchase_date: '2026-11-21',
        purchase_cost: 4000,
        gst_amount: 720,
      },
      1,
    );
    assert.equal(jack.sku, 'FA-0001');
    assert.equal(jack.supplier_id, null);
    assert.equal(jack.paid_from, 'CASH');
    assert.equal(cash(), before - 4720);
    assert.equal(ledger('workshop_equipment'), 4720);

    const lift = inventory.createFixedAsset(
      {
        asset_name: 'Old car lift',
        purchase_date: '2020-04-01',
        purchase_cost: 90000,
        paid_from: 'EARLIER',
      },
      1,
    );
    assert.equal(lift.sku, 'FA-0002');
    assert.equal(cash(), before - 4720);
    assert.equal(ledger('workshop_equipment'), 94720);

    assert.throws(
      () => money.cancelEntry(jack.voucher_id, 1),
      /Cancel this on the Fixed assets screen/,
    );
    const cancelled = inventory.cancelFixedAsset(jack.id, 1);
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cash(), before);
    assert.equal(ledger('workshop_equipment'), 90000);
    assert.throws(() => inventory.cancelFixedAsset(jack.id, 1), /already cancelled/);
    assert.throws(
      () =>
        inventory.createFixedAsset(
          { asset_name: 'Bad', purchase_date: '2026-11-21', purchase_cost: 1, paid_from: 'GOLD' },
          1,
        ),
      /how it was paid/,
    );
  } finally {
    await context.close();
  }
});

test('upgrading keeps equipment registered before code and supplier became optional', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { default: Database } = await import('better-sqlite3');
  const { runMigrations } = await import('../../src/server/database/migration-runner.js');
  const { fileURLToPath } = await import('node:url');
  const fullSource = fileURLToPath(
    new URL('../../src/server/database/migrations', import.meta.url),
  );
  const older = fs.mkdtempSync(path.join(os.tmpdir(), 'goldy-mig-'));
  try {
    for (const file of fs.readdirSync(fullSource))
      if (file.endsWith('.sql') && file < '049')
        fs.copyFileSync(path.join(fullSource, file), path.join(older, file));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, older);
    const supplier = db
      .prepare("INSERT INTO suppliers (name) VALUES ('Old Supplier')")
      .run().lastInsertRowid;
    db.prepare(
      `INSERT INTO fixed_assets (asset_name, sku, supplier_id, invoice_number, purchase_date, purchase_cost)
       VALUES ('Old compressor', 'OLD-1', ?, 'B-9', '2025-05-01', 30000)`,
    ).run(supplier);
    runMigrations(db, fullSource);
    const kept = db.prepare("SELECT * FROM fixed_assets WHERE sku = 'OLD-1'").get();
    assert.equal(kept.asset_name, 'Old compressor');
    assert.equal(kept.supplier_id, supplier);
    assert.equal(kept.paid_from, 'EARLIER');
    assert.equal(kept.status, 'ACTIVE');
    db.prepare(
      "INSERT INTO fixed_assets (asset_name, purchase_date, purchase_cost) VALUES ('No details', '2026-11-01', 10)",
    ).run();
    assert.equal(db.pragma('foreign_key_check(fixed_assets)').length, 0);
    db.close();
  } finally {
    fs.rmSync(older, { recursive: true, force: true });
  }
});
