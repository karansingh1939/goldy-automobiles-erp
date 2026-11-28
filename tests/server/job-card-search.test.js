import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestContext } from './helpers.js';
import { JobCardService } from '../../src/server/modules/job-cards/job-card.service.js';

test('job card search finds exact numbers, car numbers, phones and names first', async () => {
  const context = await createTestContext();
  try {
    const service = new JobCardService(context.db);
    const open = (name, phone, registration) =>
      service.create(
        {
          customer_name: name,
          phone,
          registration_number: registration,
          make: 'Maruti',
          model: 'Alto',
          odometer_reading: 100,
          complaint: 'Service',
        },
        1,
      );
    const first = open('Search Owner One', '9000080001', 'HR05SR0001');
    open('Search Owner Two', '9000080002', 'HR05SR0002');

    const find = (search, extra = {}) => service.list({ search, ...extra }).pagination;
    const byNumber = service.list({ search: first.job_card_number });
    assert.equal(byNumber.pagination.matchType, 'Job Card Number');
    assert.equal(byNumber.data.length, 1);
    assert.equal(find('HR05SR0002').matchType, 'Registration Number');
    assert.equal(find('9000080001').matchType, 'Phone Number');
    assert.equal(find('search owner two').matchType, 'Customer Name');

    const partial = service.list({ search: 'Search Owner' });
    assert.equal(partial.pagination.matchType, '');
    assert.equal(partial.data.length, 2);
    assert.equal(service.list({ search: 'Search Owner', exactMatchOnly: 'true' }).data.length, 0);
    assert.equal(find('Search Owner', { exactMatchOnly: 'true' }).unfilteredTotal, 2);
  } finally {
    await context.close();
  }
});
