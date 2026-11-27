import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/api-client.js';
import { invalidateInventory } from '../../shared/api/inventory-cache.js';
import { usePermissions } from '../../shared/hooks/use-permissions.js';
import { localDate } from '../../../../public/local-date.js';
import {
  BelowZeroNote,
  bankAccounts,
  payingAccount,
  useMoneyAccounts,
} from '../../shared/components/MoneyWarning.jsx';
import {
  Field,
  RecordSelect,
  Notice,
  Register,
  columnsFor,
  inputClass,
  buttonClass,
  useInventoryMutation,
} from './inventory-ui.jsx';

const empty = () => ({
  asset_name: '',
  purchase_date: localDate(),
  purchase_cost: '',
  gst_amount: '0',
  paid_from: 'CASH',
  payment_account_id: '',
  supplier_id: '',
  sku: '',
  category: 'Equipment',
  invoice_number: '',
  serial_number: '',
  warranty_info: '',
  notes: '',
});
const PAID_FROM = {
  CASH: 'Cash',
  BANK: 'Bank / UPI / card',
  EARLIER: 'Bought before using this app',
};
const MORE = [
  ['sku', 'Code (made for you if blank)'],
  ['invoice_number', 'Invoice number'],
  ['category', 'Kind'],
  ['serial_number', 'Serial number'],
  ['warranty_info', 'Warranty'],
  ['notes', 'Notes'],
];

/** Workshop tools and machines, kept apart from parts sold to customers. */
export default function FixedAssetManager() {
  const client = useQueryClient();
  const [form, setForm] = useState(empty);
  const [confirmId, setConfirmId] = useState(null);
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('inventory.write');
  const accounts = useMoneyAccounts();
  const banks = bankAccounts(accounts);
  const refreshMoney = () => client.invalidateQueries({ queryKey: ['money-accounts'] });
  const save = useInventoryMutation('/api/v1/inventory/assets', () => {
    setForm(empty());
    refreshMoney();
  });
  const cancel = useMutation({
    mutationFn: (id) => api.post(`/api/v1/inventory/assets/${id}/cancel`, {}),
    onSuccess: () => {
      setConfirmId(null);
      invalidateInventory(client);
      refreshMoney();
    },
  });
  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const total = (Number(form.purchase_cost) || 0) + (Number(form.gst_amount) || 0);

  return (
    <section className="p-6 space-y-5">
      <h1 className="text-xl font-bold">Fixed assets</h1>
      <p>Tools and machines the workshop owns (not parts sold to customers).</p>
      {canWrite && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({
              ...form,
              supplier_id: form.supplier_id ? Number(form.supplier_id) : null,
              purchase_cost: Number(form.purchase_cost),
              gst_amount: Number(form.gst_amount) || 0,
              payment_account_id:
                form.paid_from === 'BANK' ? Number(form.payment_account_id) || null : null,
            });
          }}
        >
          <fieldset disabled={save.isPending} className="grid gap-4 md:grid-cols-3">
            <Field
              label="Asset name"
              required
              value={form.asset_name}
              onChange={update('asset_name')}
            />
            <Field
              label="Date bought"
              type="date"
              required
              value={form.purchase_date}
              onChange={update('purchase_date')}
            />
            <Field
              label="Price"
              type="number"
              min={0}
              step="0.01"
              required
              value={form.purchase_cost}
              onChange={update('purchase_cost')}
            />
            <Field
              label="GST paid"
              type="number"
              min={0}
              step="0.01"
              value={form.gst_amount}
              onChange={update('gst_amount')}
            />
            <label className="block space-y-1 text-sm">
              <span>Paid from</span>
              <select
                aria-label="Paid from"
                className={inputClass}
                value={form.paid_from}
                onChange={update('paid_from')}
              >
                {Object.entries(PAID_FROM).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {form.paid_from === 'BANK' && (
              <label className="block space-y-1 text-sm">
                <span>Bank account</span>
                <select
                  aria-label="Bank account"
                  className={inputClass}
                  value={form.payment_account_id}
                  onChange={update('payment_account_id')}
                >
                  <option value="">
                    {banks.length === 1 ? banks[0].name : 'Choose bank account'}
                  </option>
                  {banks.length > 1 &&
                    banks.map((bank) => (
                      <option key={bank.id} value={bank.id}>
                        {bank.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <RecordSelect
              label="Supplier (optional)"
              endpoint="/api/v1/suppliers"
              required={false}
              value={form.supplier_id}
              onChange={(value) => setForm({ ...form, supplier_id: value })}
            />
          </fieldset>
          <details className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <summary className="cursor-pointer text-sm font-semibold">
              More details (optional)
            </summary>
            <fieldset disabled={save.isPending} className="mt-3 grid gap-4 md:grid-cols-3">
              {MORE.map(([key, label]) => (
                <Field key={key} label={label} value={form[key]} onChange={update(key)} />
              ))}
            </fieldset>
          </details>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {form.paid_from === 'EARLIER'
              ? 'Cash and bank will not change.'
              : `₹${total.toFixed(2)} will be taken from ${form.paid_from === 'CASH' ? 'cash' : 'the bank'}.`}
          </p>
          {form.paid_from !== 'EARLIER' && (
            <BelowZeroNote
              amount={total}
              account={payingAccount(accounts, {
                cash: form.paid_from === 'CASH',
                bankId: form.payment_account_id,
              })}
            />
          )}
          <button className={buttonClass} disabled={save.isPending}>
            Register asset
          </button>
          <Notice error={save.error} message={save.message} />
        </form>
      )}
      <Notice error={cancel.error} />
      <Register
        endpoint="/api/v1/inventory/assets"
        search
        columns={[
          ...columnsFor(['sku', 'asset_name', 'purchase_date']),
          {
            id: 'total',
            header: 'Total cost',
            cell: (info) =>
              (
                Number(info.row.original.purchase_cost) + Number(info.row.original.gst_amount)
              ).toFixed(2),
          },
          {
            id: 'paid_from',
            header: 'Paid from',
            cell: (info) => PAID_FROM[info.row.original.paid_from] || '',
          },
          ...columnsFor(['supplier_name', 'invoice_number', 'serial_number']),
          {
            id: 'action',
            header: '',
            cell: ({ row: { original } }) => {
              if (original.status === 'CANCELLED') return 'Cancelled';
              if (!canWrite) return null;
              if (confirmId === original.id)
                return (
                  <span className="flex gap-2">
                    <button
                      type="button"
                      className="rounded bg-red-600 px-2 py-1 text-sm text-white"
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(original.id)}
                    >
                      Yes, cancel
                    </button>
                    <button
                      type="button"
                      className="rounded border px-2 py-1 text-sm"
                      onClick={() => setConfirmId(null)}
                    >
                      No
                    </button>
                  </span>
                );
              return (
                <button
                  type="button"
                  className="rounded border px-2 py-1 text-sm"
                  aria-label={`Cancel ${original.asset_name}`}
                  onClick={() => setConfirmId(original.id)}
                >
                  Cancel
                </button>
              );
            },
          },
        ]}
        emptyStateMessage="No fixed assets registered."
      />
    </section>
  );
}
