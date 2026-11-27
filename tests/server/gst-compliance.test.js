import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext } from './helpers.js';

async function login(context) {
  const result = await context.request('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username: 'admin',
      password: 'Admin@12345',
    }),
  });
  assert.equal(result.response.status, 200);
  return result.body.token;
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

test('GST Engine & Tax Compliance Sprint 5 - End-to-End', async () => {
  const context = await createTestContext();
  const db = context.db;

  try {
    const token = await login(context);
    const headers = {
      ...authHeaders(token),
      'Content-Type': 'application/json',
    };

    // Verify company state is seeded
    const company = db.prepare('SELECT state FROM companies WHERE id = 1').get();
    assert.equal(company.state, 'Haryana');

    // 1. Seed customers in different states
    const localCustomer = db
      .prepare(
        `
      INSERT INTO customers (name, phone, state)
      VALUES ('Haryana Customer', '9999999999', 'Haryana')
    `,
      )
      .run().lastInsertRowid;

    const interstateCustomer = db
      .prepare(
        `
      INSERT INTO customers (name, phone, state)
      VALUES ('Delhi Customer', '8888888888', 'Delhi')
    `,
      )
      .run().lastInsertRowid;

    // Seed suppliers in different states
    db
      .prepare(
        `
      INSERT INTO suppliers (name, phone, state, is_active, ledger_id)
      VALUES ('Haryana Supplier', '1111111111', 'Haryana', 1, 13) -- rent expense ledger as temporary AP ledger placeholder
    `,
      )
      .run().lastInsertRowid;

    const interstateSupplierId = db
      .prepare(
        `
      INSERT INTO suppliers (name, phone, state, is_active, ledger_id)
      VALUES ('Delhi Supplier', '2222222222', 'Delhi', 1, 14) -- salary expense ledger as placeholder
    `,
      )
      .run().lastInsertRowid;

    // Seed inventory item
    const itemId = db
      .prepare(
        `
      INSERT INTO inventory_items (sku, item_name, purchase_cost, selling_price, current_quantity, gst_rate, hsn_sac_code, is_active)
      VALUES ('COMP-ENG-01', 'Piston Rings', 100, 150, 100, 18, '84099111', 1)
    `,
      )
      .run().lastInsertRowid;

    db.prepare(
      `
      INSERT INTO inventory_batches (item_id, warehouse_id, batch_number, purchase_cost, selling_price, quantity)
      VALUES (?, 1, 'BATCH-001', 100, 150, 100)
    `,
    ).run(itemId);

    // 2. Perform Local (Intra-state) Sale
    const localSaleRes = await context.request('/api/v1/accounting/direct-invoices', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerId: localCustomer,
        invoiceDate: '2026-06-10',
        items: [
          {
            itemId,
            quantity: 2,
            unitPrice: 200,
            gstRate: 18,
            warehouseId: 1,
          },
        ],
      }),
    });
    assert.equal(localSaleRes.response.status, 201);
    const localInvoice = localSaleRes.body.data;
    assert.equal(localInvoice.grandTotal, 472); // 400 + 72 (18% of 400)

    // Verify stored tax components
    const localInvoiceRow = db
      .prepare('SELECT cgst_total, sgst_total, igst_total FROM direct_invoices WHERE id = ?')
      .get(localInvoice.invoiceId);
    assert.equal(localInvoiceRow.cgst_total, 36);
    assert.equal(localInvoiceRow.sgst_total, 36);
    assert.equal(localInvoiceRow.igst_total, 0);

    // 3. Perform Interstate Sale
    const interstateSaleRes = await context.request('/api/v1/accounting/direct-invoices', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        customerId: interstateCustomer,
        invoiceDate: '2026-06-12',
        items: [
          {
            itemId,
            quantity: 2,
            unitPrice: 200,
            gstRate: 18,
            warehouseId: 1,
          },
        ],
      }),
    });
    assert.equal(interstateSaleRes.response.status, 201);
    const interstateInvoice = interstateSaleRes.body.data;

    const interstateInvoiceRow = db
      .prepare('SELECT cgst_total, sgst_total, igst_total FROM direct_invoices WHERE id = ?')
      .get(interstateInvoice.invoiceId);
    assert.equal(interstateInvoiceRow.cgst_total, 0);
    assert.equal(interstateInvoiceRow.sgst_total, 0);
    assert.equal(interstateInvoiceRow.igst_total, 72);

    // 4. Interstate purchase through Buy Stock (input tax credit check)
    const interstatePurchaseRes = await context.request('/api/v1/purchases/receipts', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        supplier_id: interstateSupplierId,
        receipt_number: 'PUR-DEL-001',
        receipt_date: '2026-06-14',
        items: [
          { item_id: itemId, warehouse_id: 1, quantity: 5, purchase_cost: 100, gst_rate: 18 },
        ],
      }),
    });
    assert.equal(
      interstatePurchaseRes.response.status,
      201,
      JSON.stringify(interstatePurchaseRes.body),
    );
    const igstInput = db
      .prepare(
        `SELECT SUM(je.amount) AS amount FROM journal_entries je
         JOIN ledgers l ON l.id = je.ledger_id JOIN vouchers v ON v.id = je.voucher_id
         WHERE v.reference_table = 'purchase_receipts' AND l.system_key = 'igst_input'`,
      )
      .get().amount;
    assert.equal(igstInput, 90); // 18% of 500, all IGST for a Delhi supplier

    // 5. Query GSTR-3B and assert eligible ITC and ratewise breakdown
    const gstr3bRes = await context.request(
      '/api/v1/gst/gstr3b?period=custom&from=2026-06-01&to=2026-06-30',
      {
        method: 'GET',
        headers,
      },
    );
    assert.equal(gstr3bRes.response.status, 200);
    const gstr3b = gstr3bRes.body.data;

    // Outward sales totals
    assert.equal(gstr3b.outwardSupplies.taxableValue, 800); // 400 local + 400 interstate
    assert.equal(gstr3b.outwardSupplies.centralTax, 36);
    assert.equal(gstr3b.outwardSupplies.stateUtTax, 36);
    assert.equal(gstr3b.outwardSupplies.integratedTax, 72);

    // Eligible ITC totals
    assert.equal(gstr3b.eligibleItc.taxableValue, 500);
    assert.equal(gstr3b.eligibleItc.integratedTax, 90);

    // Rate breakdown
    assert.equal(gstr3b.rateBreakdown[0].gstRate, 18);
    assert.equal(gstr3b.rateBreakdown[0].taxableValue, 800);
  } finally {
    await context.close();
  }
});
