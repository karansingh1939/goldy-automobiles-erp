import { AppError } from '../../shared/errors/app-error.js';

/**
 * Service to resolve database ledger IDs and records from permanent immutable system keys.
 * Caches resolved keys in memory to minimize SQL query overhead during batch postings.
 */
export class LedgerResolverService {
  constructor(db) {
    this.db = db;
    this.cache = new Map(); // Key format: "companyId:systemKey" -> ledgerObject
  }

  getLedgerId(companyId, systemKey) {
    return this.getSystemLedger(companyId, systemKey).id;
  }

  /**
   * Resolves the entire ledger row for a given company and system key.
   *
   * @param {number} companyId - Active company ID
   * @param {string} systemKey - Permanent immutable ledger identifier
   * @returns {object} Database ledger row
   */
  getSystemLedger(companyId, systemKey) {
    if (!companyId) {
      throw new AppError(
        'Company ID is required to resolve ledgers.',
        400,
        'RESOLVER_INVALID_COMPANY',
      );
    }
    if (!systemKey) {
      throw new AppError('Ledger system key is required.', 400, 'RESOLVER_INVALID_KEY');
    }

    const cacheKey = `${companyId}:${systemKey}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const row = this.db
      .prepare('SELECT * FROM ledgers WHERE company_id = ? AND system_key = ?')
      .get(companyId, systemKey);
    if (!row) {
      throw new AppError(
        `System ledger key '${systemKey}' not found for company ${companyId}.`,
        404,
        'LEDGER_KEY_NOT_FOUND',
      );
    }

    this.cache.set(cacheKey, row);
    return row;
  }
}
