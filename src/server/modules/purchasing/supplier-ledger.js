import { roundMoney } from '../../shared/utils/numbers.js';
/**
 * The Supplier Ledger screen reads supplier_ledgers: one row per bill, payment
 * or return with the running amount still owed. Every money movement with a
 * supplier must add a row here, in the same transaction as its accounting voucher.
 */
export function recordSupplierLedgerEntry(
  db,
  { supplierId, date, entryType, referenceType, referenceId, debit = 0, credit = 0, notes, userId },
) {
  const last = db
    .prepare(
      'SELECT balance_after FROM supplier_ledgers WHERE supplier_id = ? ORDER BY id DESC LIMIT 1',
    )
    .get(supplierId);
  const balance = roundMoney(Number(last?.balance_after || 0) + credit - debit);
  db.prepare(
    `INSERT INTO supplier_ledgers
       (supplier_id, entry_date, entry_type, reference_type, reference_id, debit, credit, balance_after, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    supplierId,
    date,
    entryType,
    referenceType,
    referenceId,
    roundMoney(debit),
    roundMoney(credit),
    balance,
    notes || null,
    userId || null,
  );
  return balance;
}
