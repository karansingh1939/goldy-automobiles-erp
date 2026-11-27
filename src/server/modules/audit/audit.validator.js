import { AppError } from '../../shared/errors/app-error.js';
import { hasValue, optionalDate, parsePaging } from '../../shared/utils/validation.js';

export function parseAuditListQuery(query = {}) {
  const paging = parsePaging(query);
  const entityType = hasValue(query.entityType) ? String(query.entityType).trim() : undefined;
  const action = hasValue(query.action) ? String(query.action).trim() : undefined;
  const userId = hasValue(query.userId)
    ? Number.parseInt(query.userId, 10) || undefined
    : undefined;
  const dateFrom = optionalDate(query.dateFrom ?? query.from, 'Date from');
  const dateTo = optionalDate(query.dateTo ?? query.to, 'Date to');
  const search = hasValue(query.search) ? String(query.search).trim() : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new AppError('Date range is invalid.', 400, 'VALIDATION_ERROR');
  }

  return {
    ...paging,
    entityType,
    action,
    userId,
    dateFrom,
    dateTo,
    search,
  };
}
