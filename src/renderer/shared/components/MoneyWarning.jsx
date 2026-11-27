import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '../api/api-client.js';

const rupees = (value) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(Number(value || 0));
const accountName = (account) => (account.kind === 'CASH' ? 'Cash' : account.name);

/** Cash and bank accounts with their balances (shared cache key 'money-accounts'). */
export function useMoneyAccounts() {
  const query = useQuery({
    queryKey: ['money-accounts'],
    queryFn: () => api.get('/api/v1/accounting/money-accounts'),
    retry: false,
  });
  return Array.isArray(query.data?.data) ? query.data.data : [];
}

/**
 * Which account a payment comes out of: cash, the chosen bank, or the only
 * bank when there is just one.
 */
export function payingAccount(accounts, { cash, bankId }) {
  if (cash) return accounts.find((account) => account.kind === 'CASH') || null;
  const banks = accounts.filter((account) => account.kind === 'BANK');
  if (bankId) return banks.find((bank) => String(bank.id) === String(bankId)) || null;
  return banks.length === 1 ? banks[0] : null;
}

/**
 * A plain note under a payment form when paying would take cash or a bank
 * below zero. It does not stop the save: usually money that came in was not
 * entered yet.
 */
export function BelowZeroNote({ account, amount, className = '' }) {
  const value = Number(amount) || 0;
  if (!account || value <= 0) return null;
  const after = Math.round((Number(account.balance) - value) * 100) / 100;
  if (after >= 0) return null;
  return (
    <p
      role="note"
      className={`rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 ${className}`}
    >
      {accountName(account)} has {rupees(account.balance)}. After this it will show {rupees(after)}.
      If money came in that is not entered yet, enter it first in Money In / Out.
    </p>
  );
}

/** Home screen warning when cash or a bank already shows less than zero. */
export function NegativeMoneyBanner() {
  const below = useMoneyAccounts().filter((account) => Number(account.balance) < 0);
  if (below.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="font-semibold">Money shows below zero</p>
          <p className="text-sm">
            {below
              .map((account) => `${accountName(account)}: ${rupees(account.balance)}`)
              .join(', ')}
            . Some money received was probably not entered, or a payment was entered twice.
          </p>
        </div>
      </div>
      <a
        href="#/money"
        className="rounded-lg border border-red-400 px-4 py-2 font-semibold hover:bg-red-100 dark:hover:bg-red-900"
      >
        Check Money In / Out
      </a>
    </div>
  );
}
