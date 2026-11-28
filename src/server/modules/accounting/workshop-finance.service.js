import { localDate } from '../../shared/utils/local-date.js';
import { AppError } from '../../shared/errors/app-error.js';
import { PeriodLockService } from './period-lock.service.js';
import { WorkshopFinanceRepository } from './workshop-finance.repository.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { isIsoDate } from '../../shared/utils/validation.js';

export class WorkshopFinanceService {
  constructor(db) {
    this.repository = new WorkshopFinanceRepository(db);
    this.periodLock = new PeriodLockService(db);
  }
  ageing() {
    const date = localDate();
    const invoices = this.repository.openInvoices().filter((row) => row.outstanding > 0);
    const balances = this.repository.customerBalances();
    const customers = new Map();
    const customerOf = (row) => {
      if (!customers.has(row.customer_id))
        customers.set(row.customer_id, {
          customerId: row.customer_id,
          name: row.customer_name,
          phone: row.phone,
          documents: [],
        });
      return customers.get(row.customer_id);
    };
    for (const row of invoices) customerOf(row).documents.push(row);
    for (const row of balances) {
      const customer = customerOf(row);
      customer.ledgerBalance = roundMoney((customer.ledgerBalance || 0) + row.balance);
    }
    const buckets = { '0–30': 0, '31–60': 0, '61–90': 0, '91+': 0, unaged: 0 };
    const documents = [];
    const parties = [];
    for (const customer of customers.values()) {
      const invoiceTotal = roundMoney(
        customer.documents.reduce((sum, row) => sum + row.outstanding, 0),
      );
      const balance = customer.ledgerBalance ?? invoiceTotal;
      let credit = Math.max(0, invoiceTotal - Math.max(0, balance));
      for (const row of customer.documents) {
        const applied = Math.min(credit, row.outstanding);
        credit = roundMoney(credit - applied);
        const outstanding = roundMoney(row.outstanding - applied);
        if (outstanding <= 0) continue;
        const ageDays = Math.max(
          0,
          Math.floor(
            (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${row.invoice_date}T00:00:00Z`)) /
              86400000,
          ),
        );
        const bucket =
          ageDays <= 30 ? '0–30' : ageDays <= 60 ? '31–60' : ageDays <= 90 ? '61–90' : '91+';
        buckets[bucket] = roundMoney(buckets[bucket] + outstanding);
        documents.push({ ...row, outstanding, ageDays, bucket });
      }
      const unaged = roundMoney(Math.max(0, balance - invoiceTotal));
      buckets.unaged = roundMoney(buckets.unaged + unaged);
      if (balance !== 0 || invoiceTotal > 0)
        parties.push({
          customerId: customer.customerId,
          name: customer.name,
          phone: customer.phone,
          due: Math.max(0, balance),
          credit: Math.max(0, -balance),
          unaged,
        });
    }
    return {
      date,
      buckets,
      documents,
      customers: parties,
      totalDue: roundMoney(Object.values(buckets).reduce((sum, amount) => sum + amount, 0)),
    };
  }
  validateDate(date) {
    if (typeof date !== 'string' || !isIsoDate(date) || date > localDate())
      throw new AppError('Choose a valid cash count date up to today.', 400, 'VALIDATION_ERROR');
  }
  cashSummary(date = localDate()) {
    this.validateDate(date);
    const book = this.repository.cashBook(date);
    if (!book) throw new AppError('Cash ledger is not configured.', 409, 'CASH_LEDGER_MISSING');
    const opening = roundMoney(book.opening_balance + book.prior_net);
    return {
      date,
      opening,
      cashIn: roundMoney(book.cash_in),
      cashOut: roundMoney(book.cash_out),
      expectedClosing: roundMoney(opening + book.cash_in - book.cash_out),
      counts: this.repository.counts(date),
    };
  }
  saveCount(payload = {}, actor) {
    return this.repository.transaction(() => {
      const date = payload.date;
      this.validateDate(date);
      this.periodLock.verifyPeriodLock(1, date);
      const counted = Number(payload.countedCash);
      if (
        payload.countedCash === '' ||
        payload.countedCash === null ||
        typeof payload.countedCash === 'boolean' ||
        !Number.isFinite(counted) ||
        counted < 0 ||
        counted > 100000000 ||
        Math.abs(counted * 100 - Math.round(counted * 100)) > 0.00001
      )
        throw new AppError(
          'Counted cash must be a non-negative amount with at most two decimal places.',
          400,
          'VALIDATION_ERROR',
        );
      if (
        payload.notes !== undefined &&
        (typeof payload.notes !== 'string' || payload.notes.length > 1000)
      )
        throw new AppError('Notes must be text up to 1000 characters.', 400, 'VALIDATION_ERROR');
      const notes = payload.notes?.trim() || '';
      const expected = this.cashSummary(date).expectedClosing;
      const variance = roundMoney(counted - expected);
      if (variance !== 0 && !notes)
        throw new AppError(
          'Explain the cash variance before saving.',
          400,
          'CASH_VARIANCE_NOTE_REQUIRED',
        );
      return this.repository.saveCount(date, expected, counted, variance, notes, actor);
    });
  }
}
