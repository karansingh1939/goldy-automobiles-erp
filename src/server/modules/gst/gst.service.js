import { GstRepository } from './gst.repository.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { parseReportPeriod } from '../../shared/utils/report-period.js';

const camel = (key) => key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

/** The same data with camelCase names and every number rounded to paise. */
function present(value) {
  if (Array.isArray(value)) return value.map(present);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [camel(key), present(v)]));
  return typeof value === 'number' ? roundMoney(value) : value;
}

export class GstService {
  constructor(db) {
    this.db = db;
    this.repository = new GstRepository(db);
  }

  summary(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: present(this.repository.summary(filters)),
    };
  }

  gstr1(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: this.repository
        .gstr1Dataset(filters)
        .map((row) => ({ originalInvoiceNumber: null, ...present(row) })),
    };
  }

  gstr3b(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: present(this.repository.gstr3bDataset(filters)),
    };
  }

  hsnSummary(query = {}) {
    const filters = parseReportPeriod(query, 'GST report');

    return {
      filters,
      data: present(this.repository.hsnSummary(filters)),
    };
  }
}

export function createGstService(db) {
  return new GstService(db);
}
