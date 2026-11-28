import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { DirectBillingService } from '../../src/server/modules/accounting/direct-billing.service.js';
import { CustomerReceiptService } from '../../src/server/modules/accounting/customer-receipt.service.js';
import { ReconciliationService } from '../../src/server/modules/accounting/reconciliation.service.js';
import { InventoryService } from '../../src/server/modules/inventory/inventory.service.js';

test('the books check finds each kind of damaged record', async () => {
  const context = await createTestContext();
  try {
    const { db } = context;
    const customerId = db
      .prepare("INSERT INTO customers (name) VALUES ('Check Customer')")
      .run().lastInsertRowid;
    const bill = new DirectBillingService(db).createDirectInvoice({
      companyId: 1,
      customerId,
      invoiceDate: '2026-11-20',
      items: [{ description: 'Labour', quantity: 1, unitPrice: 1000, gstRate: 18 }],
      createdBy: 1,
    });
    const receipt = new CustomerReceiptService(db).createReceipt({
      customerId,
      receiptDate: '2026-11-20',
      amount: 500,
      paymentMode: 'CASH',
      allocations: [
        { documentType: 'direct_invoice', documentId: bill.invoiceId, allocatedAmount: 500 },
      ],
    });
    const item = new InventoryService(db).createItem(
      { sku: 'CHK-1', item_name: 'Check Part', purchase_cost: 10, selling_price: 15 },
      1,
    );
    const service = new ReconciliationService(db);
    assert.equal(service.runReconciliation(1).isHealthy, true);

    db.prepare('UPDATE customer_receipts SET unallocated_amount = 99 WHERE id = ?').run(
      receipt.receiptId,
    );
    db.prepare('UPDATE direct_invoices SET amount_paid = 1 WHERE id = ?').run(bill.invoiceId);
    db.prepare(
      "UPDATE ledger_balances SET running_balance = running_balance + 7 WHERE ledger_id = (SELECT id FROM ledgers WHERE system_key = 'cash_in_hand')",
    ).run();
    db.prepare('UPDATE inventory_items SET current_quantity = 3 WHERE id = ?').run(item.id);

    const report = service.runReconciliation(1);
    assert.equal(report.isHealthy, false);
    assert.deepEqual(report.checks.allocations.discrepancies.map((d) => d.type).sort(), [
      'customer_receipt',
      'direct_invoice',
    ]);
    assert.match(
      report.checks.allocations.discrepancies.find((d) => d.type === 'customer_receipt').message,
      /Document unallocated: 99, calculated: 0\./,
    );
    assert.equal(report.checks.ledgers.discrepancies.length, 1);
    assert.equal(report.checks.ledgers.discrepancies[0].discrepancy, -7);
    assert.deepEqual(
      report.checks.inventory.discrepancies.map((d) => [d.sku, d.discrepancy]),
      [['CHK-1', 3]],
    );
    assert.equal(report.checks.trialBalance.isBalanced, true);
  } finally {
    await context.close();
  }
});
