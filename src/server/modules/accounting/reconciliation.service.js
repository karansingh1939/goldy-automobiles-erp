import { roundMoney } from '../../shared/utils/numbers.js';

// Payments and bills whose stored amounts must equal the sum of their
// allocation rows. "unallocated" payments: amount - allocated = unallocated;
// "paid" bills: allocated = amount_paid.
const ALLOCATION_CHECKS = [
  {
    type: 'customer_receipt',
    table: 'customer_receipts',
    number: 'receipt_number',
    where: "company_id = @companyId AND status = 'ACTIVE'",
    sums: 'SELECT customer_receipt_id AS id, SUM(allocated_amount) AS total FROM receipt_allocations GROUP BY customer_receipt_id',
    kind: 'unallocated',
  },
  {
    type: 'direct_invoice',
    table: 'direct_invoices',
    number: 'invoice_number',
    where: "company_id = @companyId AND status <> 'CANCELLED'",
    sums: "SELECT document_id AS id, SUM(allocated_amount) AS total FROM receipt_allocations WHERE document_type = 'direct_invoice' GROUP BY document_id",
    kind: 'paid',
    label: 'Document paid',
  },
  {
    type: 'job_card_invoice',
    table: 'invoices',
    number: 'invoice_number',
    where: "status = 'FINALIZED'",
    sums: "SELECT document_id AS id, SUM(allocated_amount) AS total FROM receipt_allocations WHERE document_type = 'job_card_invoice' GROUP BY document_id",
    kind: 'paid',
    label: 'Invoice paid',
  },
  {
    type: 'supplier_payment',
    table: 'supplier_payments',
    number: 'payment_number',
    where: "company_id = @companyId AND status = 'ACTIVE'",
    sums: 'SELECT supplier_payment_id AS id, SUM(allocated_amount) AS total FROM supplier_allocations GROUP BY supplier_payment_id',
    kind: 'unallocated',
  },
  {
    type: 'purchase_bill',
    table: 'purchase_bills',
    number: 'bill_number',
    where: "company_id = @companyId AND status <> 'CANCELLED'",
    sums: "SELECT document_id AS id, SUM(allocated_amount) AS total FROM supplier_allocations WHERE document_type = 'purchase_bill' GROUP BY document_id",
    kind: 'paid',
    label: 'Document paid',
  },
];

const check = (discrepancies) => ({ passed: discrepancies.length === 0, discrepancies });

/**
 * Integrity check of the books: cached ledger balances, payment matching,
 * stock totals, return quantities and the trial balance. Each check is one
 * query over all rows.
 */
export class ReconciliationService {
  constructor(db) {
    this.db = db;
  }

  runReconciliation(companyId = 1) {
    const checks = {
      ledgers: check(this.checkLedgerBalances(companyId)),
      allocations: check(this.checkAllocationIntegrity(companyId)),
      inventory: check(this.checkInventoryStockIntegrity()),
      returns: check(this.checkReturnLimitsIntegrity(companyId)),
      trialBalance: this.checkTrialBalanceBalanced(companyId),
    };
    return {
      timestamp: new Date().toISOString(),
      companyId,
      isHealthy:
        checks.ledgers.passed &&
        checks.allocations.passed &&
        checks.trialBalance.isBalanced &&
        checks.inventory.passed &&
        checks.returns.passed,
      checks,
    };
  }

  /** Cached ledger_balances must equal the opening balance plus the journal entries. */
  checkLedgerBalances(companyId) {
    return this.db
      .prepare(
        `SELECT l.id, l.name, l.nature, l.opening_balance,
           COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND je.entry_type = 'DEBIT' THEN je.amount END), 0) AS debits,
           COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND je.entry_type = 'CREDIT' THEN je.amount END), 0) AS credits,
           (SELECT running_balance FROM ledger_balances lb
             WHERE lb.company_id = @companyId AND lb.ledger_id = l.id) AS cached
         FROM ledgers l
         LEFT JOIN journal_entries je ON je.ledger_id = l.id
         LEFT JOIN vouchers v ON je.voucher_id = v.id AND v.company_id = @companyId AND v.status <> 'CANCELLED'
         WHERE l.company_id = @companyId
         GROUP BY l.id`,
      )
      .all({ companyId })
      .flatMap((l) => {
        const calculated = roundMoney(
          l.opening_balance + (l.nature === 'Debit' ? l.debits - l.credits : l.credits - l.debits),
        );
        const cached = roundMoney(l.cached ?? 0);
        return Math.abs(calculated - cached) > 0.01
          ? [
              {
                ledgerId: l.id,
                ledgerName: l.name,
                expectedBalance: calculated,
                cachedBalance: cached,
                discrepancy: roundMoney(calculated - cached),
              },
            ]
          : [];
      });
  }

  /** Receipts, payments and bills must agree with their allocation rows. */
  checkAllocationIntegrity(companyId) {
    return ALLOCATION_CHECKS.flatMap(({ type, table, number, where, sums, kind, label }) =>
      this.db
        .prepare(
          `SELECT d.id, d.${number} AS number,
             ${kind === 'unallocated' ? 'd.amount, d.unallocated_amount' : 'd.amount_paid'},
             COALESCE(a.total, 0) AS allocated
           FROM ${table} d LEFT JOIN (${sums}) a ON a.id = d.id
           WHERE ${where.replaceAll(/\b(company_id|status)\b/g, 'd.$1')}`,
        )
        .all(where.includes('@companyId') ? { companyId } : {})
        .flatMap((doc) => {
          if (kind === 'unallocated') {
            const calculated = roundMoney(doc.amount - doc.allocated);
            return Math.abs(calculated - doc.unallocated_amount) > 0.01
              ? [
                  {
                    type,
                    id: doc.id,
                    number: doc.number,
                    message: `Unallocated balance mismatch. Document unallocated: ${doc.unallocated_amount}, calculated: ${calculated}.`,
                  },
                ]
              : [];
          }
          return Math.abs(roundMoney(doc.allocated) - doc.amount_paid) > 0.01
            ? [
                {
                  type,
                  id: doc.id,
                  number: doc.number,
                  message: `Amount paid mismatch. ${label}: ${doc.amount_paid}, allocations sum: ${doc.allocated}.`,
                },
              ]
            : [];
        }),
    );
  }

  /** All debits must equal all credits. */
  checkTrialBalanceBalanced(companyId) {
    const summary = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE 0 END), 0) AS debits,
           COALESCE(SUM(CASE WHEN je.entry_type = 'CREDIT' THEN je.amount ELSE 0 END), 0) AS credits
         FROM journal_entries je
         JOIN vouchers v ON je.voucher_id = v.id AND v.company_id = ? AND v.status <> 'CANCELLED'`,
      )
      .get(companyId);
    const debits = roundMoney(summary.debits);
    const credits = roundMoney(summary.credits);
    const difference = roundMoney(Math.abs(debits - credits));
    return { debits, credits, isBalanced: difference < 0.01, difference };
  }

  /** Each item's stored quantity must equal the sum of its batches. */
  checkInventoryStockIntegrity() {
    return this.db
      .prepare(
        `SELECT i.id, i.sku, i.item_name, i.current_quantity, COALESCE(SUM(b.quantity), 0) AS batch_total
         FROM inventory_items i LEFT JOIN inventory_batches b ON b.item_id = i.id
         GROUP BY i.id`,
      )
      .all()
      .filter((item) => Math.abs(Number(item.current_quantity) - Number(item.batch_total)) > 0.001)
      .map((item) => ({
        itemId: item.id,
        sku: item.sku,
        itemName: item.item_name,
        currentQuantity: item.current_quantity,
        batchQuantitySum: item.batch_total,
        discrepancy: roundMoney(Number(item.current_quantity) - Number(item.batch_total)),
      }));
  }

  /** No invoice line may be returned more times than it was sold. */
  checkReturnLimitsIntegrity(companyId) {
    return this.db
      .prepare(
        `SELECT ri.item_id, r.invoice_id, item.sku, SUM(ri.quantity) AS total_returned,
           (SELECT SUM(ii.quantity) FROM invoice_items ii
             WHERE ii.invoice_id = r.invoice_id AND ii.inventory_item_id = ri.item_id) AS original_quantity
         FROM customer_return_items ri
         JOIN customer_returns r ON ri.customer_return_id = r.id
         JOIN inventory_items item ON ri.item_id = item.id
         WHERE r.company_id = ? AND r.status <> 'CANCELLED'
         GROUP BY r.invoice_id, ri.item_id`,
      )
      .all(companyId)
      .filter((row) => Number(row.total_returned) > Number(row.original_quantity))
      .map((row) => ({
        invoiceId: row.invoice_id,
        itemId: row.item_id,
        sku: row.sku,
        totalReturned: row.total_returned,
        originalQuantity: row.original_quantity,
        discrepancy: roundMoney(Number(row.total_returned) - Number(row.original_quantity)),
      }));
  }
}
