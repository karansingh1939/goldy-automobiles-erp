import { AppError } from '../../shared/errors/app-error.js';
import { roundMoney } from '../../shared/utils/numbers.js';

const invoiceCredits = `(SELECT COALESCE(SUM(total_refund_amount), 0) FROM customer_returns
  WHERE invoice_id = invoices.id AND status = 'COMPLETED')`;

// The bills a payment can be matched to. Job card invoices keep the payment
// state in payment_status (their status is FINALIZED/CANCELLED); counter bills
// and supplier bills keep it in status.
const DOCUMENTS = {
  job_card_invoice: {
    table: 'invoices',
    party: 'customer_id',
    column: 'payment_status',
    partly: 'PARTIAL',
  },
  direct_invoice: {
    table: 'direct_invoices',
    party: 'customer_id',
    column: 'status',
    partly: 'PARTIALLY_PAID',
  },
  purchase_bill: {
    table: 'purchase_bills',
    party: 'supplier_id',
    column: 'status',
    partly: 'PARTIALLY_PAID',
  },
};

// The payments: a customer receipt or a payment to a supplier.
const PAYMENTS = {
  CUSTOMER: {
    table: 'customer_receipts',
    party: 'customer_id',
    links: 'receipt_allocations',
    key: 'customer_receipt_id',
    label: 'Receipt',
  },
  SUPPLIER: {
    table: 'supplier_payments',
    party: 'supplier_id',
    links: 'supplier_allocations',
    key: 'supplier_payment_id',
    label: 'Payment',
  },
};

const paymentKind = (type) => {
  const kind = PAYMENTS[type];
  if (!kind) throw new AppError(`Invalid allocation type: ${type}`, 400, 'INVALID_ALLOCATION_TYPE');
  return kind;
};

/**
 * Unlinks every customer payment from one bill that is being cancelled. The
 * money stays on each receipt as unused (an advance the customer has with us),
 * which is what really happened: the cash was received.
 * @returns {number} total amount released
 */
export function releaseDocumentAllocations(db, documentType, documentId) {
  const rows = db
    .prepare(
      'SELECT id, customer_receipt_id, allocated_amount FROM receipt_allocations WHERE document_type = ? AND document_id = ?',
    )
    .all(documentType, documentId);
  let released = 0;
  for (const row of rows) {
    db.prepare(
      'UPDATE customer_receipts SET unallocated_amount = ROUND(unallocated_amount + ?, 2) WHERE id = ?',
    ).run(row.allocated_amount, row.customer_receipt_id);
    db.prepare('DELETE FROM receipt_allocations WHERE id = ?').run(row.id);
    released += Number(row.allocated_amount);
  }
  return roundMoney(released);
}

/** Matches customer receipts and supplier payments to the bills they pay. */
export class AllocationService {
  constructor(db) {
    this.db = db;
  }

  allocateReceiptManual(receiptId, allocations) {
    return this.allocateManual('CUSTOMER', receiptId, allocations);
  }

  /**
   * Retrieves outstanding documents (unpaid / partially paid).
   */
  getOutstanding(type, companyId, partyId) {
    if (type === 'CUSTOMER') {
      const sql = `
        SELECT 
          id AS documentId,
          'job_card_invoice' AS documentType,
          invoice_number AS documentNumber,
          invoice_date AS date,
          grand_total AS grandTotal,
          amount_paid AS amountPaid,
          ROUND(MAX(0, grand_total - ${invoiceCredits}) - amount_paid, 2) AS outstandingAmount
        FROM invoices
        WHERE customer_id = ? AND status = 'FINALIZED'
          AND ROUND(grand_total - ${invoiceCredits} - amount_paid, 2) > 0

        UNION ALL

        SELECT 
          id AS documentId,
          'direct_invoice' AS documentType,
          invoice_number AS documentNumber,
          invoice_date AS date,
          grand_total AS grandTotal,
          amount_paid AS amountPaid,
          ROUND(grand_total - amount_paid, 2) AS outstandingAmount
        FROM direct_invoices
        WHERE company_id = ? AND customer_id = ? AND status IN ('UNPAID', 'PARTIALLY_PAID')

        ORDER BY date ASC, documentId ASC
      `;
      return this.db.prepare(sql).all(partyId, companyId, partyId);
    } else if (type === 'SUPPLIER') {
      const sql = `
        SELECT 
          id AS documentId,
          'purchase_bill' AS documentType,
          bill_number AS documentNumber,
          bill_date AS date,
          grand_total AS grandTotal,
          amount_paid AS amountPaid,
          ROUND(grand_total - amount_paid, 2) AS outstandingAmount
        FROM purchase_bills
        WHERE company_id = ? AND supplier_id = ? AND status IN ('UNPAID', 'PARTIALLY_PAID')
        ORDER BY date ASC, id ASC
      `;
      return this.db.prepare(sql).all(companyId, partyId);
    } else {
      throw new AppError(`Invalid allocation type: ${type}`, 400, 'INVALID_ALLOCATION_TYPE');
    }
  }

  /**
   * Auto-allocates payment to outstanding documents oldest-first (FIFO).
   */
  allocateFIFO(type, paymentId, companyId, partyId, amount) {
    const outstanding = this.getOutstanding(type, companyId, partyId);
    let remaining = amount;
    const allocations = [];

    for (const doc of outstanding) {
      if (remaining <= 0) break;
      const toAllocate = roundMoney(Math.min(doc.outstandingAmount, remaining));
      if (toAllocate > 0) {
        allocations.push({
          documentType: doc.documentType,
          documentId: doc.documentId,
          allocatedAmount: toAllocate,
        });
        remaining = roundMoney(remaining - toAllocate);
      }
    }

    if (allocations.length > 0) {
      this.allocateManual(type, paymentId, allocations);
    }
  }

  /**
   * Manually matches a payment to specified allocations.
   */
  allocateManual(type, paymentId, allocations) {
    return this.db.transaction(() =>
      this.allocateManualTransaction(type, paymentId, allocations),
    )();
  }

  allocateManualTransaction(type, paymentId, allocations) {
    const payment = paymentKind(type);
    const parentDoc = this.db
      .prepare(
        `SELECT amount, unallocated_amount, ${payment.party} AS partyId FROM ${payment.table} WHERE id = ? AND status = 'ACTIVE'`,
      )
      .get(paymentId);
    if (!parentDoc)
      throw new AppError(`${payment.label} document not found.`, 404, 'PAYMENT_DOCUMENT_NOT_FOUND');

    let totalAllocated = 0;
    for (const alloc of allocations) {
      const amt = roundMoney(Number(alloc.allocatedAmount));
      if (!Number.isFinite(amt) || amt <= 0) {
        throw new AppError('Allocation amount must be positive.', 400, 'INVALID_ALLOCATION_AMOUNT');
      }
      totalAllocated = roundMoney(totalAllocated + amt);
    }
    if (totalAllocated > parentDoc.unallocated_amount) {
      throw new AppError(
        `Allocation amount (${totalAllocated}) exceeds unallocated balance (${parentDoc.unallocated_amount}).`,
        400,
        'EXCEEDS_UNALLOCATED_BALANCE',
      );
    }

    const insertAlloc = this.db.prepare(
      `INSERT INTO ${payment.links} (${payment.key}, document_type, document_id, allocated_amount) VALUES (?, ?, ?, ?)`,
    );
    for (const alloc of allocations) {
      const amt = roundMoney(Number(alloc.allocatedAmount));
      const kind = DOCUMENTS[alloc.documentType];
      if (!kind)
        throw new AppError(
          `Invalid document type: ${alloc.documentType}`,
          400,
          'INVALID_DOCUMENT_TYPE',
        );
      const doc = this.document(alloc.documentType, alloc.documentId);
      if (!doc) {
        throw new AppError(
          `Document of type ${alloc.documentType} with ID ${alloc.documentId} not found.`,
          404,
          'DOCUMENT_NOT_FOUND',
        );
      }
      if (
        doc.status === 'CANCELLED' ||
        (alloc.documentType === 'job_card_invoice' && doc.status !== 'FINALIZED')
      ) {
        throw new AppError(
          'Cannot allocate to a cancelled or inactive document.',
          400,
          'DOCUMENT_NOT_ACTIVE',
        );
      }
      if ((type === 'CUSTOMER') !== (kind.party === 'customer_id')) {
        throw new AppError(
          'Document type does not match payment type.',
          400,
          'INVALID_DOCUMENT_TYPE',
        );
      }
      if (doc[kind.party] !== parentDoc.partyId) {
        throw new AppError(
          `Cannot allocate to a different party's document.`,
          400,
          'PARTY_MISMATCH',
        );
      }
      const outstanding = roundMoney(doc.grand_total - doc.amount_paid);
      if (amt > outstanding) {
        throw new AppError(
          `Allocation of ${amt} exceeds target document outstanding balance of ${outstanding}.`,
          400,
          'ALLOCATION_EXCEEDS_OUTSTANDING',
        );
      }
      this.setPaid(alloc.documentType, alloc.documentId, doc, roundMoney(doc.amount_paid + amt));
      insertAlloc.run(paymentId, alloc.documentType, alloc.documentId, amt);
    }

    this.db
      .prepare(`UPDATE ${payment.table} SET unallocated_amount = ? WHERE id = ?`)
      .run(roundMoney(parentDoc.unallocated_amount - totalAllocated), paymentId);
  }

  /** Reverses all allocations of a payment: each bill gets its amount back as unpaid. */
  cancelAllocations(type, paymentId) {
    const payment = paymentKind(type);
    const allocations = this.db
      .prepare(`SELECT * FROM ${payment.links} WHERE ${payment.key} = ?`)
      .all(paymentId);
    for (const alloc of allocations) {
      const doc =
        DOCUMENTS[alloc.document_type] && this.document(alloc.document_type, alloc.document_id);
      if (doc)
        this.setPaid(
          alloc.document_type,
          alloc.document_id,
          doc,
          roundMoney(Math.max(0, doc.amount_paid - alloc.allocated_amount)),
        );
    }
    this.db.prepare(`DELETE FROM ${payment.links} WHERE ${payment.key} = ?`).run(paymentId);
  }

  /** A bill with its total (job card invoices net of completed returns) and amount paid. */
  document(documentType, documentId) {
    const { table } = DOCUMENTS[documentType];
    const doc = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(documentId);
    if (doc && documentType === 'job_card_invoice')
      doc.grand_total = this.invoiceNetTotal(documentId);
    return doc;
  }

  /** Saves a bill's new amount paid with its PAID / partly paid / UNPAID state. */
  setPaid(documentType, documentId, doc, paid) {
    const { table, column, partly } = DOCUMENTS[documentType];
    const state = paid >= doc.grand_total ? 'PAID' : paid === 0 ? 'UNPAID' : partly;
    this.db
      .prepare(
        `UPDATE ${table} SET amount_paid = ?, ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(paid, state, documentId);
  }

  invoiceNetTotal(invoiceId) {
    const row = this.db
      .prepare(`SELECT MAX(0, grand_total - ${invoiceCredits}) AS total FROM invoices WHERE id = ?`)
      .get(invoiceId);
    if (!row) throw new AppError('Invoice not found.', 404, 'INVOICE_NOT_FOUND');
    return roundMoney(row.total);
  }

  reconcileInvoiceCredits(invoiceId) {
    const invoice = this.db.prepare('SELECT amount_paid FROM invoices WHERE id = ?').get(invoiceId);
    const netTotal = this.invoiceNetTotal(invoiceId);
    let excess = roundMoney(Math.max(0, invoice.amount_paid - netTotal));
    const allocations = this.db
      .prepare(
        "SELECT * FROM receipt_allocations WHERE document_type='job_card_invoice' AND document_id=? ORDER BY id DESC",
      )
      .all(invoiceId);
    for (const allocation of allocations) {
      if (excess <= 0) break;
      const released = roundMoney(Math.min(excess, allocation.allocated_amount));
      const retained = roundMoney(allocation.allocated_amount - released);
      if (retained > 0)
        this.db
          .prepare('UPDATE receipt_allocations SET allocated_amount=? WHERE id=?')
          .run(retained, allocation.id);
      else this.db.prepare('DELETE FROM receipt_allocations WHERE id=?').run(allocation.id);
      this.db
        .prepare(
          'UPDATE customer_receipts SET unallocated_amount=ROUND(unallocated_amount+?,2) WHERE id=?',
        )
        .run(released, allocation.customer_receipt_id);
      excess = roundMoney(excess - released);
    }
    const paid = roundMoney(Math.min(invoice.amount_paid, netTotal) + excess);
    const status = paid >= netTotal ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
    this.db
      .prepare(
        'UPDATE invoices SET amount_paid=?, payment_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?',
      )
      .run(paid, status, invoiceId);
  }
}
