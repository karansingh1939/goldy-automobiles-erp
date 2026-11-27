import { AppError } from '../../shared/errors/app-error.js';
import { localDate } from '../../shared/utils/local-date.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { AccountingPostingEngine } from './posting-engine.service.js';
import { AllocationService } from './allocation.service.js';
import { CustomerReceiptService } from './customer-receipt.service.js';
import { SupplierPaymentService } from './supplier-payment.service.js';

/**
 * Plain-language money screens for a non-accountant owner. Every entry is
 * posted through the double-entry posting engine (balanced, period-locked,
 * numbered); this service only chooses the right accounts.
 */

const CURRENT_ASSETS_GROUP = 2;
const NON_CURRENT_LIABILITIES_GROUP = 6;
const INDIRECT_INCOME_GROUP = 10;

// Where "other" money comes from or goes to, in owner's words.
const OTHER_PARTIES = {
  IN: {
    owner: { label: 'Owner put money in', systemKey: 'capital_account' },
    loan: { label: 'Loan received', systemKey: 'loans_payable' },
    income: { label: 'Other income', systemKey: 'other_income' },
  },
  OUT: {
    owner: { label: 'Owner took money out', systemKey: 'capital_account' },
    loan: { label: 'Loan repaid', systemKey: 'loans_payable' },
    expense: { label: 'Other expense', systemKey: 'misc_expense' },
  },
};
const LAZY_LEDGERS = {
  loans_payable: { name: 'Loans', group: NON_CURRENT_LIABILITIES_GROUP, nature: 'Credit' },
  other_income: { name: 'Other Income', group: INDIRECT_INCOME_GROUP, nature: 'Credit' },
  staff_advances: { name: 'Staff Advances', group: CURRENT_ASSETS_GROUP, nature: 'Debit' },
};

// Entries made by another screen are cancelled there, so their stock or bill
// is reversed too.
const CANCEL_ELSEWHERE = {
  invoices: 'Bills',
  direct_invoices: 'Counter Sale',
  expenses: 'Expenses',
  purchase_receipts: 'Buy Stock',
  purchase_returns: 'Returns',
  customer_returns: 'Returns',
  supplier_returns: 'Returns',
  stock_adjustments: 'Stock',
  fixed_assets: 'Fixed assets',
};

const roundMoney = (value) => Math.round(Number(value) * 100) / 100;
const fail = (message, code = 'VALIDATION_ERROR', status = 400) => {
  throw new AppError(message, status, code);
};

export class MoneyService {
  constructor(db, { postingEngine, auditRepository } = {}) {
    this.db = db;
    this.companyId = 1;
    this.postingEngine = postingEngine || new AccountingPostingEngine(db);
    this.auditRepository = auditRepository || new AuditRepository(db);
  }

  /** Cash in hand and every bank account, with current balances. */
  listAccounts() {
    return this.db
      .prepare(
        `SELECT l.id, l.name, l.system_key AS systemKey,
           CASE WHEN l.system_key = 'cash_in_hand' THEN 'CASH' ELSE 'BANK' END AS kind,
           ROUND(l.opening_balance + COALESCE(SUM(CASE WHEN ve.entry_type = 'DEBIT' THEN ve.amount ELSE -ve.amount END), 0), 2) AS balance
         FROM ledgers l
         LEFT JOIN journal_entries ve ON ve.ledger_id = l.id
           AND ve.voucher_id IN (SELECT id FROM vouchers WHERE status != 'CANCELLED')
         WHERE l.company_id = ? AND (l.system_key IN ('cash_in_hand', 'hdfc_bank') OR l.system_key LIKE 'bank_%')
         GROUP BY l.id
         ORDER BY kind DESC, l.id`,
      )
      .all(this.companyId);
  }

  accountById(id) {
    const account = this.listAccounts().find((row) => row.id === Number(id));
    if (!account) fail('Choose cash or one of your bank accounts.', 'MONEY_ACCOUNT_NOT_FOUND');
    return account;
  }

  /** Adds the owner's own bank account (e.g. "SBI Current Account"). */
  addBankAccount({ name } = {}, userId = null) {
    const clean = String(name || '')
      .trim()
      .slice(0, 80);
    if (!clean) fail('Give the bank account a name, for example "SBI Current Account".');
    return this.db.transaction(() => {
      if (
        this.db
          .prepare('SELECT 1 FROM ledgers WHERE company_id = ? AND name = ?')
          .get(this.companyId, clean)
      )
        fail('An account with this name already exists.', 'DUPLICATE_ACCOUNT', 409);
      const next =
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM ledgers WHERE company_id = ? AND system_key LIKE 'bank_%'",
          )
          .get(this.companyId).n + 1;
      const id = this.insertLedger(clean, CURRENT_ASSETS_GROUP, 'Debit', `bank_${next}`);
      this.auditRepository.create({
        userId,
        action: 'CREATE',
        entityType: 'bank_accounts',
        entityId: id,
        newValue: { name: clean },
      });
      return this.accountById(id);
    })();
  }

  renameBankAccount(id, { name } = {}, userId = null) {
    const account = this.accountById(id);
    if (account.kind !== 'BANK') fail('Only bank accounts can be renamed.');
    const clean = String(name || '')
      .trim()
      .slice(0, 80);
    if (!clean) fail('Give the bank account a name.');
    this.db
      .prepare('UPDATE ledgers SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(clean, account.id);
    this.auditRepository.create({
      userId,
      action: 'UPDATE',
      entityType: 'bank_accounts',
      entityId: account.id,
      oldValue: { name: account.name },
      newValue: { name: clean },
    });
    return this.accountById(account.id);
  }

  /** Money received or paid that is not a bill, supplier payment or expense. */
  recordOther({ direction, accountId, party, amount, date, note } = {}, userId = null) {
    const options = OTHER_PARTIES[direction];
    if (!options) fail('Choose Money In or Money Out.');
    const choice = options[party];
    if (!choice) fail('Choose who the money is from or for.');
    const value = roundMoney(amount);
    if (!(value > 0)) fail('Enter an amount greater than zero.');
    const account = this.accountById(accountId);
    const postingDate = date || localDate();
    const counterLedger = this.ledgerForKey(choice.systemKey);
    const result = this.postingEngine.post({
      companyId: this.companyId,
      voucherType: direction === 'IN' ? 'Receipt' : 'Payment',
      voucherDate: postingDate,
      narration: `${choice.label}${note ? `: ${String(note).trim().slice(0, 200)}` : ''}`,
      created_by: userId,
      entries:
        direction === 'IN'
          ? [
              { ledgerId: account.id, type: 'DEBIT', amount: value },
              { ledgerId: counterLedger, type: 'CREDIT', amount: value },
            ]
          : [
              { ledgerId: counterLedger, type: 'DEBIT', amount: value },
              { ledgerId: account.id, type: 'CREDIT', amount: value },
            ],
    });
    return { ...result, account: this.accountById(account.id) };
  }

  /**
   * Gives a customer back money they paid in advance (for example after a
   * paid bill was cancelled). Never more than the advance they have.
   */
  refundCustomer({ customerId, accountId, amount, date, note } = {}, userId = null) {
    const customer = this.db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
    if (!customer) fail('Choose the customer to refund.', 'CUSTOMER_NOT_FOUND', 404);
    const value = roundMoney(amount);
    if (!(value > 0)) fail('Enter an amount greater than zero.');
    const account = this.accountById(accountId);
    const ledgerId = this.postingEngine.getOrCreateCustomerLedger(this.companyId, customer.id);
    // Customer ledgers are debit when they owe us; a credit balance is their advance.
    const balance = this.db
      .prepare(
        `SELECT ROUND(COALESCE(SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE -je.amount END), 0), 2) AS net
         FROM journal_entries je JOIN vouchers v ON v.id = je.voucher_id
         WHERE je.ledger_id = ? AND v.status != 'CANCELLED'`,
      )
      .get(ledgerId).net;
    const advance = roundMoney(Math.max(0, -balance));
    if (value > advance)
      fail(
        advance > 0
          ? `${customer.name} has only ₹${advance.toFixed(2)} paid in advance.`
          : `${customer.name} has no advance to give back.`,
        'REFUND_MORE_THAN_ADVANCE',
      );
    return this.db.transaction(() => {
      const result = this.postingEngine.post({
        companyId: this.companyId,
        voucherType: 'Payment',
        voucherDate: date || localDate(),
        narration: `Refund to ${customer.name}${note ? `: ${String(note).trim().slice(0, 200)}` : ''}`,
        referenceTable: 'customer_refunds',
        referenceId: customer.id,
        created_by: userId,
        entries: [
          { ledgerId, type: 'DEBIT', amount: value },
          { ledgerId: account.id, type: 'CREDIT', amount: value },
        ],
      });
      // Use up the unmatched part of their receipts, newest first.
      let left = value;
      for (const receipt of this.db
        .prepare(
          "SELECT id, unallocated_amount FROM customer_receipts WHERE customer_id = ? AND status = 'ACTIVE' AND unallocated_amount > 0 ORDER BY id DESC",
        )
        .all(customer.id)) {
        if (left <= 0) break;
        const take = roundMoney(Math.min(left, receipt.unallocated_amount));
        this.db
          .prepare(
            'UPDATE customer_receipts SET unallocated_amount = ROUND(unallocated_amount - ?, 2) WHERE id = ?',
          )
          .run(take, receipt.id);
        left = roundMoney(left - take);
      }
      this.auditRepository.create({
        userId,
        action: 'REFUND',
        entityType: 'customers',
        entityId: customer.id,
        newValue: { amount: value, accountId: account.id, voucherId: result.voucherId },
      });
      return { ...result, account: this.accountById(account.id) };
    })();
  }

  /**
   * The last entries that moved cash or bank money, newest first, so a wrong
   * entry can be found and cancelled.
   */
  recentEntries({ limit = 20 } = {}) {
    const rows = this.db
      .prepare(
        `SELECT v.id, v.voucher_number AS number, v.voucher_date AS date, v.narration,
           v.reference_table AS referenceTable, l.name AS account, l.system_key AS accountKey,
           SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE -je.amount END) AS net
         FROM vouchers v
         JOIN journal_entries je ON je.voucher_id = v.id
         JOIN ledgers l ON l.id = je.ledger_id
         WHERE v.company_id = ? AND v.status != 'CANCELLED'
           AND (l.system_key IN ('cash_in_hand', 'hdfc_bank') OR l.system_key LIKE 'bank_%')
         GROUP BY v.id, l.id
         ORDER BY v.id DESC
         LIMIT ?`,
      )
      .all(this.companyId, Math.min(Number(limit) || 20, 100));
    return rows.map((row) => {
      const where = CANCEL_ELSEWHERE[row.referenceTable] || null;
      return {
        id: row.id,
        number: row.number,
        date: row.date,
        narration: row.narration,
        account: row.accountKey === 'cash_in_hand' ? 'Cash' : row.account,
        direction: row.net >= 0 ? 'IN' : 'OUT',
        amount: roundMoney(Math.abs(row.net)),
        cancelWhere: where,
      };
    });
  }

  /**
   * Cancels a wrong money entry. Customer and supplier payments are unmatched
   * from their bills; salary and advances are removed from Staff & Salary.
   */
  cancelEntry(voucherId, userId = null) {
    const voucher = this.db
      .prepare('SELECT * FROM vouchers WHERE id = ? AND company_id = ?')
      .get(voucherId, this.companyId);
    if (!voucher) fail('Entry not found.', 'VOUCHER_NOT_FOUND', 404);
    if (voucher.status === 'CANCELLED') fail('This entry is already cancelled.');
    const where = CANCEL_ELSEWHERE[voucher.reference_table];
    if (where) fail(`Cancel this on the ${where} screen.`, 'CANCEL_ELSEWHERE', 409);

    return this.db.transaction(() => {
      const receipt = this.db
        .prepare('SELECT id FROM customer_receipts WHERE voucher_id = ?')
        .get(voucher.id);
      if (receipt) {
        new CustomerReceiptService(this.db).cancelReceipt(receipt.id, this.companyId);
      } else if (voucher.reference_table === 'supplier_payments') {
        new SupplierPaymentService(
          this.db,
          this.postingEngine,
          new AllocationService(this.db),
        ).cancelPayment(this.companyId, voucher.reference_id);
      } else {
        const staff = this.db
          .prepare('SELECT * FROM staff_payments WHERE voucher_id = ?')
          .get(voucher.id);
        if (staff?.kind === 'ADVANCE') {
          const { left } = this.db
            .prepare(
              `SELECT ROUND(COALESCE(SUM(CASE WHEN kind = 'ADVANCE' THEN gross_amount ELSE -advance_deducted END), 0), 2) AS left
               FROM staff_payments WHERE technician_id = ? AND id != ?`,
            )
            .get(staff.technician_id, staff.id);
          if (left < 0)
            fail('Part of this advance was already cut from a salary. Cancel that salary first.');
        }
        if (voucher.reference_table === 'customer_refunds') this.restoreAdvance(voucher);
        this.postingEngine.deleteVoucher(this.companyId, voucher.id);
        if (staff) this.db.prepare('DELETE FROM staff_payments WHERE id = ?').run(staff.id);
      }
      this.auditRepository.create({
        userId,
        action: 'CANCEL',
        entityType: 'vouchers',
        entityId: voucher.id,
        oldValue: { number: voucher.voucher_number, narration: voucher.narration },
      });
      return { cancelled: true, id: voucher.id };
    })();
  }

  /** Undoing a refund gives the customer their advance back on their receipts. */
  restoreAdvance(voucher) {
    const { value } = this.db
      .prepare(
        "SELECT ROUND(SUM(amount), 2) AS value FROM journal_entries WHERE voucher_id = ? AND entry_type = 'DEBIT'",
      )
      .get(voucher.id);
    let left = roundMoney(value);
    for (const receipt of this.db
      .prepare(
        "SELECT id, amount, unallocated_amount FROM customer_receipts WHERE customer_id = ? AND status = 'ACTIVE' ORDER BY id DESC",
      )
      .all(voucher.reference_id)) {
      if (left <= 0) break;
      const { allocated } = this.db
        .prepare(
          'SELECT COALESCE(SUM(allocated_amount), 0) AS allocated FROM receipt_allocations WHERE customer_receipt_id = ?',
        )
        .get(receipt.id);
      const room = roundMoney(receipt.amount - allocated - receipt.unallocated_amount);
      const give = roundMoney(Math.min(left, room));
      if (give > 0) {
        this.db
          .prepare(
            'UPDATE customer_receipts SET unallocated_amount = ROUND(unallocated_amount + ?, 2) WHERE id = ?',
          )
          .run(give, receipt.id);
        left = roundMoney(left - give);
      }
    }
  }

  /**
   * Starting balances when moving from Tally: cash, bank, what customers owe
   * and what is owed to suppliers. Posted as one balanced journal against the
   * owner's capital account.
   */
  recordOpeningBalances({ date, lines } = {}, userId = null) {
    if (!Array.isArray(lines) || lines.length === 0) fail('Add at least one opening balance.');
    const postingDate = date || localDate();
    const capital = this.ledgerForKey('capital_account');
    const entries = [];
    let capitalNet = 0; // positive = credit capital
    for (const line of lines) {
      const value = roundMoney(line.amount);
      if (!(value > 0)) fail('Each opening balance must be greater than zero.');
      let ledgerId;
      let debit;
      if (line.type === 'cash' || line.type === 'bank') {
        ledgerId = this.accountById(line.id).id;
        debit = true;
      } else if (line.type === 'customer') {
        if (!this.db.prepare('SELECT 1 FROM customers WHERE id = ?').get(line.id))
          fail('Customer not found.', 'CUSTOMER_NOT_FOUND', 404);
        ledgerId = this.postingEngine.getOrCreateCustomerLedger(this.companyId, Number(line.id));
        debit = true;
      } else if (line.type === 'supplier') {
        ledgerId = this.postingEngine.getOrCreateSupplierLedger(this.companyId, Number(line.id));
        debit = false;
      } else fail('Opening balance type must be cash, bank, customer or supplier.');
      entries.push({ ledgerId, type: debit ? 'DEBIT' : 'CREDIT', amount: value });
      capitalNet += debit ? value : -value;
    }
    capitalNet = roundMoney(capitalNet);
    if (capitalNet !== 0)
      entries.push({
        ledgerId: capital,
        type: capitalNet > 0 ? 'CREDIT' : 'DEBIT',
        amount: Math.abs(capitalNet),
      });
    const result = this.postingEngine.post({
      companyId: this.companyId,
      voucherType: 'Journal',
      voucherDate: postingDate,
      narration: 'Opening balances (moved from previous books)',
      created_by: userId,
      entries,
    });
    this.auditRepository.create({
      userId,
      action: 'OPENING_BALANCES',
      entityType: 'vouchers',
      entityId: result.voucherId,
      newValue: { date: postingDate, lines },
    });
    return result;
  }

  ledgerForKey(systemKey) {
    const existing = this.db
      .prepare('SELECT id FROM ledgers WHERE company_id = ? AND system_key = ?')
      .get(this.companyId, systemKey);
    if (existing) return existing.id;
    const spec = LAZY_LEDGERS[systemKey];
    if (!spec) fail(`Account ${systemKey} is missing.`, 'LEDGER_NOT_FOUND', 500);
    return this.insertLedger(spec.name, spec.group, spec.nature, systemKey);
  }

  insertLedger(name, groupId, nature, systemKey) {
    const id = this.db
      .prepare(
        `INSERT INTO ledgers (company_id, name, group_id, opening_balance, nature, is_system, system_key)
         VALUES (?, ?, ?, 0, ?, 1, ?)`,
      )
      .run(this.companyId, name, groupId, nature, systemKey).lastInsertRowid;
    this.db
      .prepare(
        'INSERT OR IGNORE INTO ledger_balances (company_id, ledger_id, running_balance) VALUES (?, ?, 0)',
      )
      .run(this.companyId, id);
    return Number(id);
  }
}
