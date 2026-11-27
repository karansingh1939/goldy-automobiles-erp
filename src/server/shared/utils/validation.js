import { AppError } from '../errors/app-error.js';

/** True for anything except undefined, null and the empty string. */
export function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export function required(value, label) {
  if (!hasValue(value)) throw new AppError(`${label} is required.`, 400, 'VALIDATION_ERROR');
}

/** Page number, page size (1-100, default 20), row offset and trimmed search text. */
export function parsePaging(query = {}, defaultPageSize = 20) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(Number.parseInt(query.pageSize, 10) || defaultPageSize, 1),
    100,
  );
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    search: typeof query.search === 'string' ? query.search.trim() : '',
  };
}

/** The pagination block every list endpoint returns. */
export function pageInfo({ page, pageSize }, total) {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}

/** A real calendar date written YYYY-MM-DD (rejects 2026-02-31). */
export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** An optional YYYY-MM-DD date: null when empty, an error when malformed. */
export function optionalDate(value, label) {
  if (!hasValue(value)) return null;
  const date = String(value).trim();
  if (!isIsoDate(date))
    throw new AppError(`${label} must be a valid YYYY-MM-DD date.`, 400, 'VALIDATION_ERROR');
  return date;
}

/**
 * WHERE clause from [condition, value] pairs, keeping only the filters that
 * were given, with positional parameters: sqlWhere([['a = ?', 1], ['b = ?', '']])
 * gives { sql: 'WHERE a = ?', params: [1] }.
 */
export function sqlWhere(conditions) {
  const used = conditions.filter(([, value]) => hasValue(value));
  return {
    sql: used.length ? `WHERE ${used.map(([condition]) => condition).join(' AND ')}` : '',
    params: used.map(([, value]) => value),
  };
}
