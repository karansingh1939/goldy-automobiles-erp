import assert from 'node:assert/strict';
import test from 'node:test';
import { roundMoney, toNumber } from '../../src/server/shared/utils/numbers.js';
import { addMonths, localDateOf, monthStart } from '../../src/server/shared/utils/local-date.js';
import {
  isIsoDate,
  optionalDate,
  pageInfo,
  parsePaging,
} from '../../src/server/shared/utils/validation.js';
import { parseReportPeriod } from '../../src/server/shared/utils/report-period.js';
import { fromDatabaseError } from '../../src/server/shared/errors/database-error.js';

test('money rounds to paise the same way as before', () => {
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(27.004), 27);
  assert.equal(roundMoney(-4.567), -4.57);
  assert.equal(roundMoney('abc'), 0);
  assert.equal(toNumber('', 7), 0);
  assert.equal(toNumber(undefined, 7), 7);
});

test('adding months stays inside a short month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-08-15', 6), '2027-02-15');
  assert.equal(addMonths('2026-11-27 23:10:00', 12), '2027-11-27');
  assert.equal(monthStart('2026-11-27'), '2026-11-01');
  assert.equal(localDateOf('2026-11-27'), '2026-11-27');
  assert.match(localDateOf('2026-11-27 20:00:00'), /^2026-11-2[78]$/);
});

test('dates, paging and report periods are checked once, the same way everywhere', () => {
  assert.equal(isIsoDate('2026-02-28'), true);
  assert.equal(isIsoDate('2026-02-31'), false);
  assert.equal(optionalDate('', 'Date'), null);
  assert.throws(() => optionalDate('31-12-2026', 'Bill date'), /Bill date must be/);
  assert.deepEqual(parsePaging({ page: '3', pageSize: '500', search: ' oil ' }), {
    page: 3,
    pageSize: 100,
    offset: 200,
    search: 'oil',
  });
  assert.deepEqual(parsePaging({ page: '-2' }), { page: 1, pageSize: 20, offset: 0, search: '' });
  assert.deepEqual(pageInfo({ page: 2, pageSize: 20 }, 41), {
    page: 2,
    pageSize: 20,
    total: 41,
    totalPages: 3,
  });
  assert.deepEqual(parseReportPeriod({ from: '2026-11-01', to: '2026-11-30' }), {
    period: null,
    dateFrom: '2026-11-01',
    dateTo: '2026-11-30',
  });
  assert.throws(() => parseReportPeriod({ period: 'someday' }), /Report period is invalid/);
  assert.throws(
    () => parseReportPeriod({ dateFrom: '2026-12-01', dateTo: '2026-11-01' }),
    /Date range/,
  );
});

test('database constraint failures become plain messages', () => {
  assert.equal(fromDatabaseError({ code: 'SQLITE_CONSTRAINT_UNIQUE' }).code, 'DUPLICATE_RECORD');
  assert.equal(
    fromDatabaseError({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }, { deleting: true }).code,
    'RELATED_RECORD_EXISTS',
  );
  const other = new Error('boom');
  assert.equal(fromDatabaseError(other), other);
});
