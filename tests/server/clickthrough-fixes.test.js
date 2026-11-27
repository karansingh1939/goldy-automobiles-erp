import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { AccountingPostingEngine } from '../../src/server/modules/accounting/posting-engine.service.js';
import { AllocationService } from '../../src/server/modules/accounting/allocation.service.js';
import { SupplierPaymentService } from '../../src/server/modules/accounting/supplier-payment.service.js';
import { PurchasingService } from '../../src/server/modules/purchasing/purchasing.service.js';
import { JobCardService } from '../../src/server/modules/job-cards/job-card.service.js';
import { ReturnsService } from '../../src/server/modules/returns/returns.service.js';
import { InventoryService } from '../../src/server/modules/inventory/inventory.service.js';
import { localDate } from '../../src/server/shared/utils/local-date.js';
import { financialYearLabel } from '../../src/server/shared/utils/document-number.js';

// Problems found by clicking through the app with fictional data.

function fixture(db) {
  const supplier = db
    .prepare("INSERT INTO suppliers (name, is_active) VALUES ('Test Spares Co', 1)")
    .run().lastInsertRowid;
  const item = db
    .prepare(
      "INSERT INTO inventory_items (sku, item_name, purchase_cost, selling_price, gst_rate) VALUES ('CT-OIL', 'Test oil', 300, 455, 18)",
    )
    .run().lastInsertRowid;
  const receipt = new PurchasingService(db).createReceipt(
    {
      supplier_id: supplier,
      receipt_number: 'CT-101',
      items: [
        {
          item_id: item,
          warehouse_id: 1,
          quantity: 10,
          purchase_cost: 300,
          selling_price: 400,
          gst_rate: 18,
        },
      ],
    },
    1,
  );
  return { supplier, item, receipt };
}

test('a selling price typed on a supplier bill becomes the item price', async () => {
  const c = await createTestContext();
  try {
    const { item } = fixture(c.db);
    assert.equal(
      c.db.prepare('SELECT selling_price FROM inventory_items WHERE id = ?').get(item)
        .selling_price,
      400,
    );
    assert.ok(
      c.db
        .prepare(
          "SELECT 1 FROM audit_logs WHERE entity_type = 'inventory_items' AND entity_id = ? AND action = 'UPDATE'",
        )
        .get(item),
    );
  } finally {
    await c.close();
  }
});

test('a supplier payment and its cancellation show on the supplier ledger', async () => {
  const c = await createTestContext();
  try {
    const { supplier } = fixture(c.db);
    const payments = new SupplierPaymentService(
      c.db,
      new AccountingPostingEngine(c.db),
      new AllocationService(c.db),
    );
    const payment = payments.createPayment(1, {
      supplierId: supplier,
      paymentDate: localDate(),
      amount: 1000,
      paymentMode: 'CASH',
      createdBy: 1,
    });
    const ledger = () =>
      new PurchasingService(c.db).getSupplierLedger(supplier, { page: 1, pageSize: 20 }).data;
    assert.equal(ledger()[0].entry_type, 'Payment');
    assert.equal(ledger()[0].debit, 1000);
    assert.equal(ledger()[0].balance_after, 3540 - 1000);
    assert.equal(ledger()[0].reference_label, `Payment ${payment.payment_number}`);
    assert.equal(ledger()[1].reference_label, 'Bill CT-101');

    payments.cancelPayment(1, payment.id);
    assert.equal(ledger()[0].credit, 1000);
    assert.equal(ledger()[0].balance_after, 3540);
  } finally {
    await c.close();
  }
});

test('job cards and credit notes get short numbers in their own series', async () => {
  const c = await createTestContext();
  try {
    fixture(c.db);
    const fy = financialYearLabel(localDate());
    const jobs = new JobCardService(c.db);
    const job = jobs.create(
      { customer_name: 'Number customer', registration_number: 'HR05CT0001', odometer_reading: 1 },
      1,
    );
    assert.equal(job.job_card_number, `JC/${fy}/0001`);
    const batch = c.db.prepare('SELECT id FROM inventory_batches LIMIT 1').get().id;
    const item = c.db.prepare("SELECT id FROM inventory_items WHERE sku = 'CT-OIL'").get().id;
    jobs.addPart(job.id, { inventory_item_id: item, batch_id: batch, quantity: 2 }, 1);
    const { invoice } = jobs.finalize(job.id, 1);
    const returns = new ReturnsService(c.db);
    const created = returns.createCustomerReturn(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, quantity: 1 }] },
      1,
    );
    const number = c.db
      .prepare('SELECT return_number FROM customer_returns WHERE id = ?')
      .get(created.id ?? created.returnId).return_number;
    assert.equal(number, `CN/${fy}/0001`);
  } finally {
    await c.close();
  }
});

test('the vehicle list shows the owner name and finds a car by owner', async () => {
  const c = await createTestContext();
  try {
    const owner = c.db
      .prepare("INSERT INTO customers (name, phone) VALUES ('Owner Person', '9000000999')")
      .run().lastInsertRowid;
    c.db
      .prepare(
        "INSERT INTO vehicles (customer_id, registration_number, make, model) VALUES (?, 'HR05OW0001', 'Maruti', 'Alto')",
      )
      .run(owner);
    const login = await c.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'Admin@12345' }),
    });
    const headers = { Authorization: `Bearer ${login.body.token}` };
    const listed = await c.request('/api/v1/vehicles?search=Owner%20Person', { headers });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.data[0].customer_name, 'Owner Person');
  } finally {
    await c.close();
  }
});

test('stock counts ignore catalogue items that were never bought', async () => {
  const c = await createTestContext();
  try {
    c.db
      .prepare(
        "INSERT INTO inventory_items (sku, item_name, reorder_level) VALUES ('NEVER', 'Never bought', 5)",
      )
      .run();
    const stats = new InventoryService(c.db).dashboardStats();
    assert.equal(stats.lowStockCount, 0);
    assert.equal(stats.outOfStockCount, 0);
  } finally {
    await c.close();
  }
});

test('a paid counter sale can be cancelled and the advance refunded', async () => {
  const c = await createTestContext();
  try {
    const { item } = fixture(c.db);
    const { DirectBillingService } =
      await import('../../src/server/modules/accounting/direct-billing.service.js');
    const { CustomerReceiptService } =
      await import('../../src/server/modules/accounting/customer-receipt.service.js');
    const { MoneyService } = await import('../../src/server/modules/accounting/money.service.js');
    const billing = new DirectBillingService(c.db);
    const walkIn = billing.walkInCustomerId();
    assert.equal(billing.walkInCustomerId(), walkIn, 'walk-in customer is reused');
    // An older unpaid bill must not swallow today's cash payment.
    const older = billing.createDirectInvoice({
      customerId: walkIn,
      invoiceDate: localDate(),
      items: [{ itemId: item, warehouseId: 1, quantity: 1, unitPrice: 100, gstRate: 0 }],
    });
    const bill = billing.createDirectInvoice({
      customerId: walkIn,
      invoiceDate: localDate(),
      items: [{ itemId: item, warehouseId: 1, quantity: 1, unitPrice: 400, gstRate: 18 }],
    });
    new CustomerReceiptService(c.db).createReceipt({
      customerId: walkIn,
      receiptDate: localDate(),
      amount: bill.grandTotal,
      paymentMode: 'CASH',
      allocations: [
        {
          documentType: 'direct_invoice',
          documentId: bill.invoiceId,
          allocatedAmount: bill.grandTotal,
        },
      ],
    });
    const status = (id) =>
      c.db.prepare('SELECT status FROM direct_invoices WHERE id = ?').get(id).status;
    assert.equal(status(bill.invoiceId), 'PAID');
    assert.equal(status(older.invoiceId), 'UNPAID');

    const cancelled = billing.cancelDirectInvoice(bill.invoiceId, 1, 1);
    assert.equal(cancelled.advance_kept, bill.grandTotal);
    assert.equal(status(bill.invoiceId), 'CANCELLED');

    const money = new MoneyService(c.db);
    const cash = money.listAccounts().find((a) => a.kind === 'CASH');
    assert.throws(
      () => money.refundCustomer({ customerId: walkIn, accountId: cash.id, amount: 100000 }),
      /only/,
    );
    // They still owe ₹100 on the older bill, so only the rest is theirs to take back.
    const advance = bill.grandTotal - 100;
    money.refundCustomer({ customerId: walkIn, accountId: cash.id, amount: advance });
    assert.equal(money.accountById(cash.id).balance, 100);
    assert.equal(
      c.db
        .prepare(
          'SELECT SUM(unallocated_amount) AS left FROM customer_receipts WHERE customer_id = ?',
        )
        .get(walkIn).left,
      100,
    );
    assert.throws(
      () => money.refundCustomer({ customerId: walkIn, accountId: cash.id, amount: 1 }),
      /no advance/,
    );
  } finally {
    await c.close();
  }
});

test('wrong money entries can be cancelled from Money In / Out', async () => {
  const c = await createTestContext();
  try {
    const { item } = fixture(c.db);
    const { DirectBillingService } =
      await import('../../src/server/modules/accounting/direct-billing.service.js');
    const { CustomerReceiptService } =
      await import('../../src/server/modules/accounting/customer-receipt.service.js');
    const { MoneyService } = await import('../../src/server/modules/accounting/money.service.js');
    const { StaffPayService } =
      await import('../../src/server/modules/staff-pay/staff-pay.service.js');
    const money = new MoneyService(c.db);
    const cash = money.listAccounts().find((a) => a.kind === 'CASH');
    const billing = new DirectBillingService(c.db);
    const customer = billing.walkInCustomerId();
    const bill = billing.createDirectInvoice({
      customerId: customer,
      invoiceDate: localDate(),
      items: [{ itemId: item, warehouseId: 1, quantity: 1, unitPrice: 100, gstRate: 0 }],
    });
    // Counter bill vouchers must be cancelled on their own screen.
    const sale = money.recentEntries().find((row) => row.cancelWhere === 'Counter Sale');
    assert.equal(sale, undefined, 'a credit bill does not move cash');
    const receipt = new CustomerReceiptService(c.db).createReceipt({
      customerId: customer,
      receiptDate: localDate(),
      amount: 100,
      paymentMode: 'CASH',
      autoAllocate: true,
    });
    const status = () =>
      c.db.prepare('SELECT status FROM direct_invoices WHERE id = ?').get(bill.invoiceId).status;
    assert.equal(status(), 'PAID');
    const entry = money.recentEntries().find((row) => row.id === receipt.voucherId);
    assert.equal(entry.direction, 'IN');
    assert.equal(entry.amount, 100);
    money.cancelEntry(receipt.voucherId, 1);
    assert.equal(status(), 'UNPAID');
    assert.equal(money.accountById(cash.id).balance, 0);
    assert.throws(() => money.cancelEntry(receipt.voucherId, 1), /already cancelled/);

    // Salary paid with an advance cut: the advance cannot be undone first.
    const staffId = c.db
      .prepare(
        "INSERT INTO technicians (technician_code, full_name, phone_number, monthly_salary) VALUES ('T-1', 'Test Mechanic', '9000000777', 1000)",
      )
      .run().lastInsertRowid;
    const pay = new StaffPayService(c.db);
    const month = localDate().slice(0, 7);
    pay.giveAdvance(staffId, { amount: 300, accountId: cash.id }, 1);
    pay.paySalary(staffId, { month, amount: 1000, advanceDeducted: 300, accountId: cash.id }, 1);
    const [salaryEntry, advanceEntry] = money.recentEntries();
    assert.throws(() => money.cancelEntry(advanceEntry.id, 1), /Cancel that salary first/);
    money.cancelEntry(salaryEntry.id, 1);
    money.cancelEntry(advanceEntry.id, 1);
    assert.equal(
      c.db.prepare('SELECT COUNT(*) AS n FROM staff_payments WHERE technician_id = ?').get(staffId)
        .n,
      0,
    );
    assert.equal(money.accountById(cash.id).balance, 0);
  } finally {
    await c.close();
  }
});
