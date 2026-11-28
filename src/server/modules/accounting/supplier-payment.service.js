import { AppError } from '../../shared/errors/app-error.js';
import { recordSupplierLedgerEntry } from '../purchasing/supplier-ledger.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { nextYearlyNumber } from '../../shared/utils/document-number.js';
import { receivingLedgerId } from './ledgers.js';

function recordSupplierLedger(db, { supplierId, date, paymentId, debit, credit, notes, userId }) {
  recordSupplierLedgerEntry(db, {
    supplierId,
    date,
    entryType: 'Payment',
    referenceType: 'supplier_payments',
    referenceId: paymentId,
    debit,
    credit,
    notes,
    userId,
  });
}

/**
 * Service to manage Supplier Payments, payment vouchers, and allocations.
 */
export class SupplierPaymentService {
  constructor(db, postingEngine, allocationService) {
    this.db = db;
    this.postingEngine = postingEngine;
    this.allocationService = allocationService;
  }

  /**
   * Records a supplier payment.
   */
  createPayment(companyId, payload) {
    const {
      supplierId,
      paymentDate,
      amount,
      paymentMode,
      bankLedgerId,
      narration,
      createdBy,
      autoAllocate = true,
    } = payload;

    if (!supplierId || !paymentDate || !amount || !paymentMode) {
      throw new AppError(
        'Missing required payment fields (supplierId, paymentDate, amount, and paymentMode).',
        400,
        'MISSING_PAYMENT_FIELDS',
      );
    }

    const payAmount = roundMoney(Number(amount));
    if (payAmount <= 0) {
      throw new AppError(
        'Payment amount must be greater than zero.',
        400,
        'INVALID_PAYMENT_AMOUNT',
      );
    }

    return this.db.transaction(() => {
      // 1. Verify Supplier
      const supplier = this.db
        .prepare('SELECT name, ledger_id, is_active FROM suppliers WHERE id = ?')
        .get(supplierId);
      if (!supplier) {
        throw new AppError('Supplier not found.', 404, 'SUPPLIER_NOT_FOUND');
      }
      if (!supplier.is_active) {
        throw new AppError('Supplier is inactive.', 400, 'SUPPLIER_INACTIVE');
      }

      const creditLedgerId = receivingLedgerId(this.db, { paymentMode, bankLedgerId, companyId });

      const paymentNumber = nextYearlyNumber(this.db, {
        table: 'supplier_payments',
        column: 'payment_number',
        prefix: 'PMT',
        date: paymentDate,
      });

      // 3. Post double-entry Payment Voucher (Debit AP, Credit Cash/Bank)
      const voucher = this.postingEngine.post({
        companyId,
        voucherType: 'Payment',
        voucherDate: paymentDate,
        narration: narration || `Payment ${paymentNumber} to ${supplier.name}`,
        referenceTable: 'supplier_payments',
        referenceId: null, // Set after insert
        entries: [
          {
            // Made on first use for a supplier with no purchase posted yet.
            ledgerId: this.postingEngine.getOrCreateSupplierLedger(companyId, supplierId),
            type: 'DEBIT',
            amount: payAmount,
            narration: `Payment to supplier: ${supplier.name}`,
          },
          {
            ledgerId: creditLedgerId,
            type: 'CREDIT',
            amount: payAmount,
            narration: `Cash/Bank disbursement`,
          },
        ],
      });

      // 4. Insert Supplier Payment Header record
      const result = this.db
        .prepare(
          `
        INSERT INTO supplier_payments (payment_number, company_id, supplier_id, payment_date, amount, unallocated_amount, payment_mode, bank_ledger_id, voucher_id, status, narration, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `,
        )
        .run(
          paymentNumber,
          companyId,
          supplierId,
          paymentDate,
          payAmount,
          payAmount, // unallocated matches amount initially before allocation runs
          paymentMode,
          bankLedgerId || null,
          voucher.voucherId,
          narration || null,
          createdBy,
        );

      const paymentId = result.lastInsertRowid;

      // Update voucher with reference ID links
      this.db
        .prepare(
          "UPDATE vouchers SET reference_id = ?, reference_table = 'supplier_payments' WHERE id = ?",
        )
        .run(paymentId, voucher.voucherId);

      recordSupplierLedger(this.db, {
        supplierId,
        date: paymentDate,
        paymentId,
        debit: payAmount,
        credit: 0,
        notes: narration || `Payment ${paymentNumber}`,
        userId: createdBy,
      });

      // 5. Trigger FIFO Allocation matching if selected
      if (autoAllocate) {
        this.allocationService.allocateFIFO(
          'SUPPLIER',
          paymentId,
          companyId,
          supplierId,
          payAmount,
        );
      }

      return this.getPayment(paymentId);
    })();
  }

  /**
   * Retrieves a single supplier payment details.
   */
  getPayment(id) {
    const payment = this.db
      .prepare(
        `
      SELECT p.*, s.name AS supplier_name
      FROM supplier_payments p
      JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.id = ?
    `,
      )
      .get(id);

    if (!payment) {
      throw new AppError('Supplier Payment record not found.', 404, 'PAYMENT_NOT_FOUND');
    }

    const allocations = this.db
      .prepare(
        `
      SELECT sa.*, pb.bill_number
      FROM supplier_allocations sa
      JOIN purchase_bills pb ON sa.document_id = pb.id
      WHERE sa.supplier_payment_id = ?
    `,
      )
      .all(id);

    return {
      ...payment,
      allocations,
    };
  }

  /**
   * Cancels a supplier payment, rolls back allocations, and deletes ledger postings.
   */
  cancelPayment(companyId, id) {
    return this.db.transaction(() => {
      const payment = this.getPayment(id);
      if (payment.status === 'CANCELLED') {
        throw new AppError(
          'Supplier Payment is already cancelled.',
          400,
          'PAYMENT_ALREADY_CANCELLED',
        );
      }

      // 1. Delete associated Payment Voucher
      if (payment.voucher_id) {
        this.postingEngine.deleteVoucher(companyId, payment.voucher_id);
      }

      // 2. Rollback invoice allocations (sets bills back to UNPAID/PARTIAL)
      this.allocationService.cancelAllocations('SUPPLIER', id);

      recordSupplierLedger(this.db, {
        supplierId: payment.supplier_id,
        date: payment.payment_date,
        paymentId: id,
        debit: 0,
        credit: roundMoney(Number(payment.amount)),
        notes: `Payment ${payment.payment_number} cancelled`,
        userId: null,
      });

      // 3. Mark payment header as CANCELLED and unallocated = 0
      this.db
        .prepare(
          "UPDATE supplier_payments SET status = 'CANCELLED', unallocated_amount = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(id);

      return { success: true };
    })();
  }
}
