import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { ProfitService } from '../../src/server/modules/profit/profit.service.js';

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

async function createRecord(context, token, endpoint, payload) {
  const result = await context.request(endpoint, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });

  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.data;
}

async function createCustomer(context, token, label) {
  return createRecord(context, token, '/api/v1/customers', {
    name: `P5B ${label} ${Date.now()} ${Math.floor(Math.random() * 10000)}`,
    phone: `96${Math.floor(10000000 + Math.random() * 89999999)}`,
    city: 'Pune',
  });
}

async function createVehicle(context, token, customerId, label) {
  return createRecord(context, token, '/api/v1/vehicles', {
    customer_id: customerId,
    registration_number: `MH12P5${label}${Math.floor(100 + Math.random() * 899)}`,
    make: 'Maruti',
    model: 'Swift',
    odometer_reading: 50000,
  });
}

async function createSupplier(context, token) {
  return createRecord(context, token, '/api/v1/suppliers', {
    name: `P5B Supplier ${Date.now()} ${Math.floor(Math.random() * 10000)}`,
    phone: `95${Math.floor(10000000 + Math.random() * 89999999)}`,
  });
}

async function createInventoryItem(context, token, payload) {
  const category = context.db
    .prepare('SELECT id FROM inventory_categories ORDER BY id LIMIT 1')
    .get();
  return createRecord(context, token, '/api/v1/inventory/items', {
    sku: payload.sku,
    item_name: payload.item_name,
    category_id: category.id,
    supplier_id: payload.supplier_id,
    purchase_cost: payload.purchase_cost,
    selling_price: payload.selling_price,
    reorder_level: 1,
    gst_rate: 0,
    unit_of_measure: 'pcs',
  });
}

async function createOpeningStock(context, token, payload) {
  return createRecord(context, token, '/api/v1/inventory/opening-stock', payload);
}

async function createJobInvoice(context, token, setup) {
  const admin = context.db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  const customer = await createCustomer(context, token, setup.label);
  const vehicle = await createVehicle(context, token, customer.id, setup.label);
  const jobCard = await createRecord(context, token, '/api/v1/job-cards', {
    customer_id: customer.id,
    vehicle_id: vehicle.id,
    odometer_reading: 50100,
    complaint: `P5B service ${setup.label}`,
    assigned_to: admin.id,
  });

  await createRecord(context, token, `/api/v1/job-cards/${jobCard.id}/parts`, {
    inventory_item_id: setup.item.id,
    batch_id: setup.batch.id,
    quantity: setup.quantity,
    selling_price: setup.sellingPrice,
    gst_rate: 0,
  });

  if (setup.labourCharge) {
    await createRecord(context, token, `/api/v1/job-cards/${jobCard.id}/labour`, {
      description: `P5B labour ${setup.label}`,
      labour_charge: setup.labourCharge,
      gst_rate: 0,
    });
  }

  const finalized = await createRecord(
    context,
    token,
    `/api/v1/job-cards/${jobCard.id}/finalize`,
    {},
  );
  context.db
    .prepare(
      `
    UPDATE invoices
    SET invoice_date = ?
    WHERE id = ?
  `,
    )
    .run(setup.invoiceDate, finalized.invoice.id);

  return {
    customer,
    vehicle,
    jobCard: finalized.jobCard,
    invoice: {
      ...finalized.invoice,
      invoice_date: setup.invoiceDate,
    },
  };
}

async function createExpense(context, token, payload) {
  return createRecord(context, token, '/api/v1/expenses', payload);
}

async function createProfitFixture(context, token) {
  const supplier = await createSupplier(context, token);
  const mainWarehouse = context.db.prepare("SELECT id FROM warehouses WHERE code = 'MAIN'").get();
  const juneItem = await createInventoryItem(context, token, {
    sku: `P5B-JUNE-${Math.floor(Math.random() * 100000)}`,
    item_name: 'P5B June Brake Pad',
    supplier_id: supplier.id,
    purchase_cost: 100,
    selling_price: 150,
  });
  const mayItem = await createInventoryItem(context, token, {
    sku: `P5B-MAY-${Math.floor(Math.random() * 100000)}`,
    item_name: 'P5B May Filter',
    supplier_id: supplier.id,
    purchase_cost: 80,
    selling_price: 200,
  });
  const cancelledItem = await createInventoryItem(context, token, {
    sku: `P5B-CANCEL-${Math.floor(Math.random() * 100000)}`,
    item_name: 'P5B Cancelled Part',
    supplier_id: supplier.id,
    purchase_cost: 100,
    selling_price: 300,
  });

  const juneStock = await createOpeningStock(context, token, {
    item_id: juneItem.id,
    warehouse_id: mainWarehouse.id,
    supplier_id: supplier.id,
    batch_number: `P5B-JUNE-B${Math.floor(Math.random() * 100000)}`,
    quantity: 5,
    unit_cost: 100,
    reason: 'P5B June setup',
  });
  const mayStock = await createOpeningStock(context, token, {
    item_id: mayItem.id,
    warehouse_id: mainWarehouse.id,
    supplier_id: supplier.id,
    batch_number: `P5B-MAY-B${Math.floor(Math.random() * 100000)}`,
    quantity: 5,
    unit_cost: 80,
    reason: 'P5B May setup',
  });
  const cancelledStock = await createOpeningStock(context, token, {
    item_id: cancelledItem.id,
    warehouse_id: mainWarehouse.id,
    supplier_id: supplier.id,
    batch_number: `P5B-CANCEL-B${Math.floor(Math.random() * 100000)}`,
    quantity: 5,
    unit_cost: 100,
    reason: 'P5B cancellation setup',
  });

  const june = await createJobInvoice(context, token, {
    label: 'June',
    item: juneItem,
    batch: juneStock.batch,
    quantity: 2,
    sellingPrice: 150,
    labourCharge: 500,
    invoiceDate: '2026-06-04',
  });
  const may = await createJobInvoice(context, token, {
    label: 'May',
    item: mayItem,
    batch: mayStock.batch,
    quantity: 1,
    sellingPrice: 200,
    labourCharge: 0,
    invoiceDate: '2026-05-20',
  });
  const cancelled = await createJobInvoice(context, token, {
    label: 'Cancel',
    item: cancelledItem,
    batch: cancelledStock.batch,
    quantity: 1,
    sellingPrice: 300,
    labourCharge: 0,
    invoiceDate: '2026-06-10',
  });

  const cancelResult = await context.request(`/api/v1/invoices/${cancelled.invoice.id}/cancel`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  assert.equal(cancelResult.response.status, 200, JSON.stringify(cancelResult.body));

  await createExpense(context, token, {
    expense_date: '2026-06-01',
    category: 'Rent',
    amount: 100,
    description: 'P5B June rent',
  });
  await createExpense(context, token, {
    expense_date: '2026-06-15',
    category: 'Internet',
    amount: 50,
    description: 'P5B June internet',
  });
  await createExpense(context, token, {
    expense_date: '2026-05-25',
    category: 'Fuel',
    amount: 30,
    description: 'P5B May fuel',
  });

  return {
    june,
    may,
    cancelled,
    juneItem,
    mayItem,
    cancelledItem,
  };
}

// The profit summary and best-customers figures feed the Home screen.
const june = { period: 'custom', dateFrom: '2026-06-01', dateTo: '2026-06-30' };

test('profit summary integrates expenses, calculates net profit, and excludes cancelled invoices', async () => {
  const context = await createTestContext();
  try {
    const token = await login(context);
    await createProfitFixture(context, token);
    assert.deepEqual(new ProfitService(context.db).summary(june).data, {
      totalRevenue: 800,
      totalCost: 200,
      grossProfit: 600,
      totalExpenses: 150,
      netProfit: 450,
    });
  } finally {
    await context.close();
  }
});

test('best customers group active invoice profit by customer', async () => {
  const context = await createTestContext();
  try {
    const token = await login(context);
    const fixture = await createProfitFixture(context, token);
    const byCustomer = new ProfitService(context.db).byCustomer(june).data;
    assert.equal(byCustomer.length, 1);
    assert.equal(byCustomer[0].customerId, fixture.june.customer.id);
    assert.equal(byCustomer[0].revenue, 800);
    assert.equal(byCustomer[0].profit, 600);
  } finally {
    await context.close();
  }
});

test('profit dates are validated', async () => {
  const context = await createTestContext();
  try {
    const profit = new ProfitService(context.db);
    assert.throws(
      () => profit.summary({ period: 'custom', dateFrom: '2026-06-30', dateTo: '2026-06-01' }),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => profit.summary({ period: 'custom', dateFrom: '2026-06-01' }),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  } finally {
    await context.close();
  }
});
