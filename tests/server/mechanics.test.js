import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';

// Everything the Mechanics screen does, through the same API calls.
test('mechanics can be added, found, edited, switched off and on, assigned and reviewed', async () => {
  const context = await createTestContext();
  try {
    const login = await context.request('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'Admin@12345' }),
    });
    const headers = {
      Authorization: `Bearer ${login.body.token}`,
      'Content-Type': 'application/json',
    };
    const call = (path, method = 'GET', body) =>
      context.request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });

    const missing = await call('/api/v1/technicians', 'POST', { full_name: 'No Phone' });
    assert.equal(missing.response.status, 400);
    assert.match(missing.body.error.message, /Phone number is required/);

    const created = await call('/api/v1/technicians', 'POST', {
      full_name: 'Test Mechanic Ram',
      phone_number: '9000000001',
      specialization: 'Engine',
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;

    const found = await call('/api/v1/technicians?search=Ram');
    assert.equal(found.body.data.length, 1);
    assert.equal(found.body.data[0].metrics.activeJobs, 0);

    const edited = await call(`/api/v1/technicians/${id}`, 'PATCH', {
      specialization: 'Electrical',
    });
    assert.equal(edited.body.data.specialization, 'Electrical');

    const off = await call(`/api/v1/technicians/${id}`, 'DELETE');
    assert.equal(off.body.data.is_active, 0);

    const job = await call('/api/v1/job-cards', 'POST', {
      customer_name: 'Mechanic Test Customer',
      phone: '9000000002',
      registration_number: 'HR05MT0001',
      make: 'Maruti',
      model: 'Alto',
      odometer_reading: 1000,
      complaint: 'Service',
    });
    assert.equal(job.response.status, 201, JSON.stringify(job.body));
    const jobId = job.body.data.id;

    const refused = await call(`/api/v1/technicians/${id}/assign`, 'POST', { jobCardId: jobId });
    assert.equal(refused.response.status, 400);
    assert.match(refused.body.error.message, /switched off/);

    const on = await call(`/api/v1/technicians/${id}`, 'PATCH', { is_active: true });
    assert.equal(on.body.data.is_active, 1);

    const assigned = await call(`/api/v1/technicians/${id}/assign`, 'POST', { jobCardId: jobId });
    assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));

    const history = await call(`/api/v1/technicians/${id}/history`);
    assert.equal(history.response.status, 200);
    assert.equal(history.body.metrics.totalAssignedJobs, 1);
    assert.equal(history.body.history[0].vehicle.registrationNumber, 'HR05MT0001');

    const unknown = await call('/api/v1/technicians/999');
    assert.equal(unknown.response.status, 404);
    assert.match(unknown.body.error.message, /Mechanic was not found/);
  } finally {
    await context.close();
  }
});
