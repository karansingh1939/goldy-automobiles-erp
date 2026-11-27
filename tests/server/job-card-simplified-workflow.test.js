import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../../src/server/app.js';
import { createDatabase } from '../../src/server/database/connection.js';
import { runMigrations } from '../../src/server/database/migration-runner.js';
import { runSeeds } from '../../src/server/database/seed-runner.js';

async function createTestContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goldy-erp-workflow-'));
  const dbPath = path.join(tempDir, 'test.sqlite');
  const db = createDatabase(dbPath);

  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_DEFAULT_PASSWORD = 'Admin@12345';
  process.env.SESSION_TTL_HOURS = '12';

  runMigrations(db);
  await runSeeds(db);

  const adminRole = db.prepare("SELECT id FROM roles WHERE name = 'Admin'").get();
  const bcrypt = await import('bcryptjs');
  const passwordHash = await bcrypt.default.hash('Admin@12345', 12);
  db.prepare(
    `
    INSERT INTO users (name, username, password_hash, role_id, is_active)
    VALUES (?, ?, ?, ?, 1)
  `,
  ).run('System Administrator', 'admin', passwordHash, adminRole.id);

  const app = createApp({ db });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();

  async function request(pathname, options = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    return { response, body };
  }

  async function close() {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  return { db, request, close };
}

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

test('Job Card Simplified Workflow - Customer name used for suggestions only, no automatic merge by name', async () => {
  const context = await createTestContext();

  try {
    const token = await login(context);
    const headers = authHeaders(token);

    // Create an existing customer
    context.db
      .prepare(
        `
      INSERT INTO customers (id, name, phone, address, city)
      VALUES (10, 'Mohan Motors', '9876543210', '123 G.T. Road', 'Karnal')
    `,
      )
      .run();

    // 1. Save Job Card with a new registration number and empty phone, but matching name 'Mohan Motors'.
    // Since name is suggestions only, this MUST create a NEW customer, not merge/match with Customer 10!
    const payloadNewCustomer = {
      registration_number: 'HR26AB1234',
      customer_name: 'Mohan Motors',
      phone: null,
      model: 'Swift VXI',
      fuel_type: 'Petrol',
      odometer_reading: 12000,
      complaint: 'Engine oil change and general service',
    };

    const res1 = await context.request('/api/v1/job-cards', {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadNewCustomer),
    });

    assert.equal(res1.response.status, 201);
    const jobCard1 = res1.body.data;
    assert.ok(jobCard1.customer_id);
    assert.ok(jobCard1.vehicle_id);
    assert.notEqual(jobCard1.customer_id, 10); // Must be a newly created customer ID!

    // Verify customer count is now 2 (Mohan Motors ID 10 and the newly created Mohan Motors)
    const customers = context.db
      .prepare("SELECT * FROM customers WHERE name = 'Mohan Motors'")
      .all();
    assert.equal(customers.length, 2);
  } finally {
    await context.close();
  }
});

test('Job Card Simplified Workflow - Automatic matching by Reg and Phone and duplicate prevention', async () => {
  const context = await createTestContext();

  try {
    const token = await login(context);
    const headers = authHeaders(token);

    // 1. Create a job card (triggers creation of new customer & vehicle)
    const payload = {
      registration_number: 'HR26XY9999',
      customer_name: 'Rajesh Kumar',
      phone: '9876123456',
      model: 'Alto LXI',
      fuel_type: 'Petrol',
      odometer_reading: 34000,
      complaint: 'Brake pad noise',
    };

    const res1 = await context.request('/api/v1/job-cards', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    assert.equal(res1.response.status, 201);
    const jc1 = res1.body.data;
    const initialCustomerId = jc1.customer_id;
    const initialVehicleId = jc1.vehicle_id;

    // 2. Submit another job card with same Registration Number.
    // It should match the existing vehicle and customer (duplicate prevention).
    const payloadSameReg = {
      registration_number: 'HR26XY9999',
      customer_name: 'Rajesh Kumar Updated', // Name updated
      phone: '9876123456',
      model: 'Alto LXI',
      fuel_type: 'Petrol',
      odometer_reading: 35000, // Odometer increased
      complaint: 'Second service visit',
    };

    const res2 = await context.request('/api/v1/job-cards', {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadSameReg),
    });

    assert.equal(res2.response.status, 201);
    const jc2 = res2.body.data;
    assert.equal(jc2.customer_id, initialCustomerId);
    assert.equal(jc2.vehicle_id, initialVehicleId);

    // Verify name was updated in the DB
    const updatedCustomer = context.db
      .prepare('SELECT * FROM customers WHERE id = ?')
      .get(initialCustomerId);
    assert.equal(updatedCustomer.name, 'Rajesh Kumar Updated');

    // 3. Submit a job card for a NEW vehicle but same Phone Number.
    // It should match/link to the existing customer (no duplicate customer) but create a new vehicle.
    const payloadNewVehSamePhone = {
      registration_number: 'HR26ZZ8888',
      customer_name: 'Rajesh Kumar Updated',
      phone: '9876123456', // Same phone
      model: 'i20 Asta',
      fuel_type: 'Diesel',
      odometer_reading: 5000,
      complaint: 'First inspection service',
    };

    const res3 = await context.request('/api/v1/job-cards', {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadNewVehSamePhone),
    });

    assert.equal(res3.response.status, 201);
    const jc3 = res3.body.data;
    assert.equal(jc3.customer_id, initialCustomerId); // Linked to same customer
    assert.notEqual(jc3.vehicle_id, initialVehicleId); // New vehicle ID created

    // Total customers with phone '9876123456' must be exactly 1
    const matchingCustomers = context.db
      .prepare("SELECT * FROM customers WHERE phone = '9876123456'")
      .all();
    assert.equal(matchingCustomers.length, 1);

    // Total vehicles linked to this customer must be 2
    const customerVehicles = context.db
      .prepare('SELECT * FROM vehicles WHERE customer_id = ?')
      .all(initialCustomerId);
    assert.equal(customerVehicles.length, 2);
  } finally {
    await context.close();
  }
});
