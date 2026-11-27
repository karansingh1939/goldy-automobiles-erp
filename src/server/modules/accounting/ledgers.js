import { AppError } from '../../shared/errors/app-error.js';

/** Account groups seeded by migration 024. */
export const LedgerGroup = Object.freeze({
  CURRENT_ASSETS: 2,
  FIXED_ASSETS: 3,
  CURRENT_LIABILITIES: 5,
  NON_CURRENT_LIABILITIES: 6,
  INDIRECT_INCOME: 10,
});

// System accounts made the first time something needs them.
const ON_DEMAND = {
  loans_payable: { name: 'Loans', groupId: LedgerGroup.NON_CURRENT_LIABILITIES, nature: 'Credit' },
  other_income: { name: 'Other Income', groupId: LedgerGroup.INDIRECT_INCOME, nature: 'Credit' },
  staff_advances: { name: 'Staff Advances', groupId: LedgerGroup.CURRENT_ASSETS, nature: 'Debit' },
  workshop_equipment: {
    name: 'Workshop Equipment',
    groupId: LedgerGroup.FIXED_ASSETS,
    nature: 'Debit',
  },
};

/** Adds a ledger with a zero opening balance and its running-balance row; returns its id. */
export function insertLedger(
  db,
  { name, groupId, nature, systemKey = null, linkedType = null, linkedId = null, companyId = 1 },
) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO ledgers (company_id, name, group_id, opening_balance, nature, is_system,
           system_key, linked_entity_type, linked_entity_id)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(companyId, name, groupId, nature, linkedType ? 0 : 1, systemKey, linkedType, linkedId)
      .lastInsertRowid,
  );
  db.prepare(
    'INSERT OR IGNORE INTO ledger_balances (company_id, ledger_id, running_balance) VALUES (?, ?, 0)',
  ).run(companyId, id);
  return id;
}

/** A system ledger by its key, created on first use for the on-demand ones. */
export function systemLedgerId(db, systemKey, companyId = 1) {
  const existing = db
    .prepare('SELECT id FROM ledgers WHERE company_id = ? AND system_key = ?')
    .get(companyId, systemKey);
  if (existing) return existing.id;
  const spec = ON_DEMAND[systemKey];
  if (!spec) throw new AppError(`Account ${systemKey} is missing.`, 500, 'LEDGER_NOT_FOUND');
  return insertLedger(db, { ...spec, systemKey, companyId });
}

/**
 * The ledger money leaves from or arrives in: Cash, or a bank account (the
 * chosen one, or the only one when there is just one).
 */
export function cashOrBankLedgerId(
  db,
  { cash, bankId = null, companyId = 1, message = 'Choose which bank account.' },
) {
  if (cash) return systemLedgerId(db, 'cash_in_hand', companyId);
  const banks = db
    .prepare(
      "SELECT id FROM ledgers WHERE company_id = ? AND (system_key = 'hdfc_bank' OR system_key LIKE 'bank_%') ORDER BY id",
    )
    .all(companyId);
  const chosen = bankId
    ? banks.find((bank) => bank.id === Number(bankId))
    : banks.length === 1
      ? banks[0]
      : null;
  if (!chosen) throw new AppError(message, 400, 'BANK_ACCOUNT_REQUIRED');
  return chosen.id;
}
