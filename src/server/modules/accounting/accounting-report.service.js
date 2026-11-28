import { AppError } from '../../shared/errors/app-error.js';
import { roundMoney } from '../../shared/utils/numbers.js';
import { isIsoDate } from '../../shared/utils/validation.js';

/**
 * Trial balance, profit and loss, balance sheet, and the ledger and voucher lists.
 * Executes balance aggregation directly from database journals.
 */
function requireDates(message, ...dates) {
  if (!dates.every((date) => date && isIsoDate(date)))
    throw new AppError(message, 400, 'REPORT_INVALID_DATE');
}

export class AccountingReportService {
  /**
   * @param {object} db - Database connection instance
   */
  constructor(db) {
    this.db = db;
  }

  /** Every ledger with its group name, A to Z. */
  listLedgers(companyId = 1) {
    return this.db
      .prepare(
        `SELECT l.id, l.name, l.group_id, l.opening_balance, l.nature, l.system_key, ag.name AS group_name
         FROM ledgers l JOIN account_groups ag ON l.group_id = ag.id
         WHERE l.company_id = ? ORDER BY l.name`,
      )
      .all(companyId);
  }

  /** Vouchers, newest first, filtered by date range, type and number/narration text. */
  listVouchers({ startDate, endDate, type, search } = {}, companyId = 1) {
    // Only the filters given go into the SQL, so SQLite can use its date index.
    let sql = 'SELECT * FROM vouchers WHERE company_id = ?';
    const params = [companyId];
    if (startDate) {
      sql += ' AND voucher_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      sql += ' AND voucher_date <= ?';
      params.push(endDate);
    }
    if (type) {
      sql += ' AND voucher_type = ?';
      params.push(type);
    }
    if (search) {
      sql += ' AND (voucher_number LIKE ? OR narration LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    return this.db.prepare(`${sql} ORDER BY voucher_date DESC, id DESC`).all(...params);
  }

  /**
   * Each ledger's debits, credits and balance (in its own direction: a debit
   * ledger counts debits as plus) from the opening balance up to a date.
   */
  ledgerBalances(companyId, asOfDate, { natures = null, orderBy }) {
    return this.db
      .prepare(
        `SELECT l.id AS ledger_id, l.name AS ledger_name, l.nature AS ledger_nature, l.opening_balance,
           ag.name AS group_name, ag.nature AS group_nature,
           COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND je.entry_type = 'DEBIT' THEN je.amount ELSE 0 END), 0) AS total_debit,
           COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND je.entry_type = 'CREDIT' THEN je.amount ELSE 0 END), 0) AS total_credit
         FROM ledgers l
         JOIN account_groups ag ON l.group_id = ag.id
         LEFT JOIN journal_entries je ON je.ledger_id = l.id
         LEFT JOIN vouchers v ON je.voucher_id = v.id AND v.voucher_date <= ? AND v.company_id = ? AND v.status <> 'CANCELLED'
         WHERE l.company_id = ? ${natures ? `AND ag.nature IN (${natures.map(() => '?').join(', ')})` : ''}
         GROUP BY l.id
         ORDER BY ${orderBy}`,
      )
      .all(asOfDate, companyId, companyId, ...(natures || []))
      .map((row) => ({
        ...row,
        net:
          row.ledger_nature === 'Debit'
            ? row.opening_balance + row.total_debit - row.total_credit
            : row.opening_balance + row.total_credit - row.total_debit,
      }));
  }

  /** Trial balance as of a date: every ledger's balance on the debit or credit side. */
  getTrialBalance(companyId, asOfDate) {
    requireDates('As-of date in YYYY-MM-DD format is required.', asOfDate);
    let grandDebitTotal = 0;
    let grandCreditTotal = 0;
    const ledgers = this.ledgerBalances(companyId, asOfDate, {
      orderBy: 'ag.nature, ag.name, l.name',
    }).map((row) => {
      const balance = roundMoney(Math.abs(row.net));
      // A negative balance sits on the other side.
      const debitSide = (row.ledger_nature === 'Debit') === row.net >= 0;
      if (debitSide) grandDebitTotal += balance;
      else grandCreditTotal += balance;
      return {
        ledgerId: row.ledger_id,
        ledgerName: row.ledger_name,
        groupName: row.group_name,
        groupNature: row.group_nature,
        openingBalance: roundMoney(row.opening_balance),
        debits: roundMoney(row.total_debit),
        credits: roundMoney(row.total_credit),
        balance,
        balanceType: debitSide ? 'DEBIT' : 'CREDIT',
      };
    });
    return {
      asOfDate,
      ledgers,
      totals: {
        debits: roundMoney(grandDebitTotal),
        credits: roundMoney(grandCreditTotal),
        isBalanced: Math.abs(grandDebitTotal - grandCreditTotal) < 0.01,
      },
    };
  }

  /**
   * Generates a Profit & Loss statement for a date range.
   *
   * @param {number} companyId - Active company ID
   * @param {string} startDate - Date in YYYY-MM-DD
   * @param {string} endDate - Date in YYYY-MM-DD
   * @returns {object} P&L statement including revenues, expenses, gross profit, and net profit
   */
  getProfitLoss(companyId, startDate, endDate) {
    requireDates('Start and end dates in YYYY-MM-DD format are required.', startDate, endDate);

    const query = `
      SELECT 
        l.id AS ledger_id,
        l.name AS ledger_name,
        ag.name AS group_name,
        ag.nature AS group_nature,
        COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND je.entry_type = 'DEBIT' THEN je.amount ELSE 0 END), 0) AS period_debit,
        COALESCE(SUM(CASE WHEN v.id IS NOT NULL AND je.entry_type = 'CREDIT' THEN je.amount ELSE 0 END), 0) AS period_credit
      FROM ledgers l
      JOIN account_groups ag ON l.group_id = ag.id
      LEFT JOIN journal_entries je ON je.ledger_id = l.id
      LEFT JOIN vouchers v ON je.voucher_id = v.id AND v.voucher_date >= ? AND v.voucher_date <= ? AND v.company_id = ? AND v.status <> 'CANCELLED'
      WHERE l.company_id = ? AND ag.nature IN ('Revenue', 'Expense')
      GROUP BY l.id
      ORDER BY ag.nature, l.name
    `;

    const rows = this.db.prepare(query).all(startDate, endDate, companyId, companyId);

    const revenues = [];
    const expenses = [];
    let grossRevenue = 0;
    let cogs = 0;
    let totalIndirectExpenses = 0;

    for (const row of rows) {
      const { ledger_id, ledger_name, group_name, group_nature, period_debit, period_credit } = row;

      if (group_nature === 'Revenue') {
        const netRev = period_credit - period_debit; // Credits increase Revenue
        const amt = roundMoney(netRev);
        if (amt !== 0) {
          revenues.push({ ledgerId: ledger_id, ledgerName: ledger_name, amount: amt });
          grossRevenue += amt;
        }
      } else if (group_nature === 'Expense') {
        const netExp = period_debit - period_credit; // Debits increase Expense
        const amt = roundMoney(netExp);
        if (amt !== 0) {
          expenses.push({
            ledgerId: ledger_id,
            ledgerName: ledger_name,
            groupName: group_name,
            amount: amt,
          });
          if (ledger_name === 'Cost of Goods Sold' || group_name === 'Direct Expenses') {
            cogs += amt;
          } else {
            totalIndirectExpenses += amt;
          }
        }
      }
    }

    const grossProfit = roundMoney(grossRevenue - cogs);
    const netProfit = roundMoney(grossProfit - totalIndirectExpenses);

    return {
      period: { startDate, endDate },
      revenue: {
        items: revenues,
        total: roundMoney(grossRevenue),
      },
      costOfGoodsSold: roundMoney(cogs),
      grossProfit,
      expenses: {
        items: expenses,
        total: roundMoney(totalIndirectExpenses),
      },
      netProfit,
    };
  }

  /**
   * Generates a Balance Sheet as of a specific date.
   *
   * @param {number} companyId - Active company ID
   * @param {string} asOfDate - Date in YYYY-MM-DD
   * @returns {object} Balance Sheet statement verifying Assets = Liabilities + Equity
   */
  getBalanceSheet(companyId, asOfDate) {
    requireDates('As-of date in YYYY-MM-DD format is required.', asOfDate);

    // 1. Calculate dynamic Retained Earnings (cumulative P&L from inception up to target date)
    const retainedQuery = `
      SELECT 
        (
          SELECT COALESCE(SUM(CASE WHEN je.entry_type = 'CREDIT' THEN je.amount ELSE -je.amount END), 0)
          FROM journal_entries je
          JOIN vouchers v ON je.voucher_id = v.id AND v.voucher_date <= ? AND v.company_id = ? AND v.status <> 'CANCELLED'
          JOIN ledgers l ON je.ledger_id = l.id
          JOIN account_groups ag ON l.group_id = ag.id
          WHERE l.company_id = ? AND ag.nature = 'Revenue'
        ) - (
          SELECT COALESCE(SUM(CASE WHEN je.entry_type = 'DEBIT' THEN je.amount ELSE -je.amount END), 0)
          FROM journal_entries je
          JOIN vouchers v ON je.voucher_id = v.id AND v.voucher_date <= ? AND v.company_id = ? AND v.status <> 'CANCELLED'
          JOIN ledgers l ON je.ledger_id = l.id
          JOIN account_groups ag ON l.group_id = ag.id
          WHERE l.company_id = ? AND ag.nature = 'Expense'
        ) AS net_retained
    `;

    const retainedResult = this.db
      .prepare(retainedQuery)
      .get(asOfDate, companyId, companyId, asOfDate, companyId, companyId);
    const dynamicRetainedEarnings = roundMoney(retainedResult ? retainedResult.net_retained : 0);

    // 2. Asset, liability and equity ledgers (the stored Retained Earnings
    // ledger is replaced by the profit worked out above).
    const sections = { Asset: [], Liability: [], Equity: [] };
    const totals = { Asset: 0, Liability: 0, Equity: 0 };
    for (const row of this.ledgerBalances(companyId, asOfDate, {
      natures: ['Asset', 'Liability', 'Equity'],
      orderBy: 'ag.nature, l.name',
    })) {
      if (row.group_nature === 'Equity' && row.ledger_name === 'Retained Earnings') continue;
      const amount = roundMoney(row.net);
      sections[row.group_nature].push(
        row.group_nature === 'Equity'
          ? { ledgerId: row.ledger_id, ledgerName: row.ledger_name, amount }
          : {
              ledgerId: row.ledger_id,
              ledgerName: row.ledger_name,
              groupName: row.group_name,
              amount,
            },
      );
      totals[row.group_nature] += amount;
    }
    const { Asset: assets, Liability: liabilities, Equity: equities } = sections;
    const { Asset: totalAssets, Liability: totalLiabilities } = totals;
    let totalEquity = totals.Equity;

    // Append dynamic retained earnings to equity
    equities.push({
      ledgerName: 'Retained Earnings (Dynamic P&L)',
      amount: dynamicRetainedEarnings,
    });
    totalEquity += dynamicRetainedEarnings;

    return {
      asOfDate,
      assets: {
        items: assets,
        total: roundMoney(totalAssets),
      },
      liabilities: {
        items: liabilities,
        total: roundMoney(totalLiabilities),
      },
      equity: {
        items: equities,
        total: roundMoney(totalEquity),
      },
      totals: {
        totalLiabilitiesAndEquity: roundMoney(totalLiabilities + totalEquity),
        isBalanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
      },
    };
  }
}
