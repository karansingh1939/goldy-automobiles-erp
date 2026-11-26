import assert from 'node:assert/strict';
import test from 'node:test';
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

test('service reminders: due reminders are listed and can be dismissed', async () => {
  const context = await createTestContext();
  try {
    const headers = authHeaders(await login(context));
    const customer = context.db
      .prepare("INSERT INTO customers (name, phone) VALUES ('Reminder Owner', '9000000555')")
      .run().lastInsertRowid;
    const vehicle = context.db
      .prepare(
        "INSERT INTO vehicles (customer_id, registration_number, make, model) VALUES (?, 'DL3CA1234', 'Hyundai', 'i20')",
      )
      .run(customer).lastInsertRowid;
    context.db
      .prepare(
        `INSERT INTO service_reminders (customer_id, vehicle_id, reminder_type, due_date, status, notes)
         VALUES (?, ?, 'MAINTENANCE', '2026-07-01', 'PENDING', 'Six month check')`,
      )
      .run(customer, vehicle);

    const reminders = await context.request('/api/v1/crm/reminders', { headers });
    assert.equal(reminders.response.status, 200);
    assert.equal(reminders.body.data[0].customer_name, 'Reminder Owner');

    const dismissed = await context.request(
      `/api/v1/crm/reminders/${reminders.body.data[0].id}/dismiss`,
      { method: 'POST', headers },
    );
    assert.equal(dismissed.response.status, 200);
    const after = await context.request('/api/v1/crm/reminders', { headers });
    assert.equal(after.body.data.length, 0);
  } finally {
    await context.close();
  }
});
