import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { InventoryService } from '../../src/server/modules/inventory/inventory.service.js';

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
