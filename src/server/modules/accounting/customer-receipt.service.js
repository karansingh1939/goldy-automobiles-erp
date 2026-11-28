import { AppError } from '../../shared/errors/app-error.js';
import { AccountingPostingEngine } from './posting-engine.service.js';
import { AllocationService } from './allocation.service.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { isIsoDate } from '../../shared/utils/validation.js';
import { nextYearlyNumber } from '../../shared/utils/document-number.js';
import { receivingLedgerId } from './ledgers.js';

/**
 * Service to handle customer payments, deposits, advances, and cancellations.
 */
export class CustomerReceiptService {
  constructor(db) {
    this.db = db;
    this.postingEngine = new AccountingPostingEngine(db);
    this.allocationService = new AllocationService(db);
  }

  /**
   * Records a customer receipt and posts the corresponding double-entry accounting voucher.
   */
  createReceipt(payload) {
    const {
      companyId = 1,
      customerId,
      receiptDate,
      amount,
      paymentMode,
      bankLedgerId = null,
      narration = '',
      createdBy = null,
      autoAllocate = false,
      allocations = null, // [{ documentType, documentId, allocatedAmount }] to pay named bills
    } = payload;

    // 1. Validations
    if (!customerId || !receiptDate || !amount || !paymentMode) {
      throw new AppError(
        'Customer, date, amount, and payment mode are required.',
        400,
        'RECEIPT_INVALID_PAYLOAD',
      );
    }

    const receiptAmount = roundMoney(Number(amount));
    if (Number.isNaN(receiptAmount) || receiptAmount <= 0) {
      throw new AppError(
        'Receipt amount must be a positive number.',
        400,
        'RECEIPT_INVALID_AMOUNT',
      );
    }

    if (!isIsoDate(receiptDate)) {
      throw new AppError('Receipt date must be YYYY-MM-DD.', 400, 'RECEIPT_INVALID_DATE');
    }

    if (!['CASH', 'BANK'].includes(paymentMode)) {
      throw new AppError('Payment mode must be CASH or BANK.', 400, 'RECEIPT_INVALID_MODE');
    }

    // Verify customer exists
    const customer = this.db
      .prepare('SELECT name, ledger_id FROM customers WHERE id = ?')
      .get(customerId);
    if (!customer) {
      throw new AppError('Customer not found.', 404, 'CUSTOMER_NOT_FOUND');
    }

    const customerLedgerId = this.postingEngine.getOrCreateCustomerLedger(companyId, customerId);

    const cashOrBankId = receivingLedgerId(this.db, { paymentMode, bankLedgerId, companyId });

    return this.db.transaction(() => {
      const receiptNumber = nextYearlyNumber(this.db, {
        table: 'customer_receipts',
        column: 'receipt_number',
        prefix: 'REC',
        date: receiptDate,
      });

      // 3. Post Receipt Voucher
      const voucherResult = this.postingEngine.post({
        companyId,
        voucherType: 'Receipt',
        voucherDate: receiptDate,
        narration: narration || `Receipt ${receiptNumber} from ${customer.name}`,
        created_by: createdBy,
        entries: [
          { ledgerId: cashOrBankId, type: 'DEBIT', amount: receiptAmount },
          { ledgerId: customerLedgerId, type: 'CREDIT', amount: receiptAmount },
        ],
      });

      // 4. Insert Receipt Record
      const insert = this.db.prepare(`
        INSERT INTO customer_receipts (
          receipt_number, company_id, customer_id, receipt_date, amount, payment_mode, 
          bank_ledger_id, unallocated_amount, voucher_id, status, narration, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
      `);
      const info = insert.run(
        receiptNumber,
        companyId,
        customerId,
        receiptDate,
        receiptAmount,
        paymentMode,
        bankLedgerId,
        receiptAmount, // Unallocated initially
        voucherResult.voucherId,
        narration,
        createdBy,
      );

      const receiptId = info.lastInsertRowid;
      // Link the voucher back to its receipt (used when an entry is cancelled).
      this.db
        .prepare(
          "UPDATE vouchers SET reference_table = 'customer_receipts', reference_id = ? WHERE id = ?",
        )
        .run(receiptId, voucherResult.voucherId);

      // 5. Pay the named bills, or match oldest bills first if requested
      if (Array.isArray(allocations) && allocations.length) {
        this.allocationService.allocateManualTransaction('CUSTOMER', receiptId, allocations);
      } else if (autoAllocate) {
        this.allocationService.allocateFIFO(
          'CUSTOMER',
          receiptId,
          companyId,
          customerId,
          receiptAmount,
        );
      }

      return {
        receiptId,
        receiptNumber,
        amount: receiptAmount,
        voucherId: voucherResult.voucherId,
        voucherNumber: voucherResult.voucherNumber,
      };
    })();
  }

  /**
   * Cancels a receipt document, reverses all linked allocations, and deletes the accounting voucher.
   */
  cancelReceipt(receiptId, companyId = 1) {
    return this.db.transaction(() => {
      const receipt = this.db
        .prepare('SELECT * FROM customer_receipts WHERE id = ? AND company_id = ?')
        .get(receiptId, companyId);
      if (!receipt) {
        throw new AppError('Receipt document not found.', 404, 'RECEIPT_NOT_FOUND');
      }

      if (receipt.status === 'CANCELLED') {
        throw new AppError('Receipt is already cancelled.', 400, 'RECEIPT_ALREADY_CANCELLED');
      }

      // 1. Reverse allocations
      this.allocationService.cancelAllocations('CUSTOMER', receiptId);

      // 2. Reverse accounting entries by cancelling/deleting voucher
      if (receipt.voucher_id) {
        this.postingEngine.deleteVoucher(companyId, receipt.voucher_id);
      }

      // 3. Update status to CANCELLED and zero out unallocated balance
      this.db
        .prepare(
          "UPDATE customer_receipts SET status = 'CANCELLED', unallocated_amount = 0 WHERE id = ?",
        )
        .run(receiptId);

      return true;
    })();
  }

  /**
   * Manually allocates a receipt balance to outstanding invoices.
   */
  allocateReceiptManual(receiptId, allocations) {
    return this.db.transaction(() => {
      this.allocationService.allocateReceiptManual(receiptId, allocations);
      return true;
    })();
  }
}
