import { AppError } from '../../shared/errors/app-error.js';

const PREFIXES = {
  Sales: 'SAL',
  Purchase: 'PUR',
  Receipt: 'REC',
  Payment: 'PAY',
  Contra: 'CON',
  Journal: 'JRN',
  'Debit Note': 'DBN',
  'Credit Note': 'CRN',
};

/** Voucher numbers per type and calendar year: SAL-2026-000001. */
export class VoucherNumberService {
  constructor(db) {
    this.db = db;
  }

  /**
   * Generates the next sequential unique voucher number (e.g. SAL-2026-000001).
   *
   * @param {number} companyId - Active company ID
   * @param {string} voucherType - 'Sales', 'Purchase', 'Receipt', 'Payment', etc.
   * @param {string} date - Posting date in YYYY-MM-DD format
   * @returns {string} Unique sequence string
   */
  getNextVoucherNumber(companyId, voucherType, date) {
    if (!companyId) {
      throw new AppError(
        'Company ID is required to generate sequence.',
        400,
        'SEQUENCING_INVALID_COMPANY',
      );
    }
    if (!voucherType) {
      throw new AppError(
        'Voucher type is required to generate sequence.',
        400,
        'SEQUENCING_INVALID_TYPE',
      );
    }
    if (!date) {
      throw new AppError('Date is required to generate sequence.', 400, 'SEQUENCING_INVALID_DATE');
    }

    const prefix = PREFIXES[voucherType] || 'VCH';
    const start = `${prefix}-${date.slice(0, 4)}-`;
    const row = this.db
      .prepare(
        `SELECT voucher_number FROM vouchers
         WHERE company_id = ? AND voucher_type = ? AND voucher_number LIKE ?
         ORDER BY voucher_number DESC LIMIT 1`,
      )
      .get(companyId, voucherType, `${start}%`);
    const last = Number.parseInt(row?.voucher_number?.split('-').pop(), 10);
    return `${start}${String((Number.isNaN(last) ? 0 : last) + 1).padStart(6, '0')}`;
  }
}
