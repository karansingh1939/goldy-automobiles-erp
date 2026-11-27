import { AppError } from '../errors/app-error.js';
import { localDate, monthStart } from './local-date.js';
import { optionalDate } from './validation.js';

/**
 * Report date range from a query: a named period (today, this month, this
 * year, custom) or dateFrom/dateTo (also accepted as from/to). reportName
 * starts the message for an unknown period.
 */
export function parseReportPeriod(query = {}, reportName = 'Report') {
  const period = query.period
    ? String(query.period)
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_')
    : null;
  const today = localDate();
  let dateFrom = optionalDate(query.dateFrom ?? query.from, 'Date from');
  let dateTo = optionalDate(query.dateTo ?? query.to, 'Date to');

  if (period === 'today') [dateFrom, dateTo] = [today, today];
  else if (period === 'this_month') [dateFrom, dateTo] = [monthStart(today), today];
  else if (period === 'this_year') [dateFrom, dateTo] = [`${today.slice(0, 4)}-01-01`, today];
  else if (period === 'custom') {
    if (!dateFrom || !dateTo)
      throw new AppError('Custom range requires dateFrom and dateTo.', 400, 'VALIDATION_ERROR');
  } else if (period)
    throw new AppError(`${reportName} period is invalid.`, 400, 'VALIDATION_ERROR');

  if (dateFrom && dateTo && dateFrom > dateTo)
    throw new AppError('Date range is invalid.', 400, 'VALIDATION_ERROR');
  return { period, dateFrom, dateTo };
}
