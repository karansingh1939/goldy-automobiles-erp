import React, { useState } from 'react';
import { formatLocalTimestamp } from '../../shared/utils/date-time.js';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/api-client.js';
import { usePermissions } from '../../shared/hooks/use-permissions.js';
import { localDate } from '../../../../public/local-date.js';

const money = (amount) => `₹${Number(amount || 0).toFixed(2)}`;
function Table({ caption, columns, rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th key={key} scope="col" className="p-2">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.id ? `${row.document_type || ''}-${row.id}` : row.customerId || index}
              className="border-t dark:border-gray-800"
            >
              {columns.map(([key, , format]) => (
                <td key={key} className="p-2">
                  {format ? format(row[key]) : (row[key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="p-3 text-sm text-gray-500">No records.</p>}
    </div>
  );
}

export default function WorkshopFinance() {
  const { hasPermission } = usePermissions();
  const client = useQueryClient();
  const [date, setDate] = useState(localDate());
  const [countedCash, setCountedCash] = useState('');
  const [notes, setNotes] = useState('');
  const [saved, setSaved] = useState(false);
  const enabled = hasPermission('accounting.read');
  const ageing = useQuery({
    queryKey: ['receivable-ageing'],
    queryFn: () => api.get('/api/v1/accounting/receivable-ageing'),
    enabled,
  });
  const cash = useQuery({
    queryKey: ['daily-cash', date],
    queryFn: () => api.get(`/api/v1/accounting/daily-cash?date=${date}`),
    enabled: enabled && Boolean(date),
  });
  const mutation = useMutation({
    mutationFn: () =>
      api.post('/api/v1/accounting/daily-cash', { date, countedCash: Number(countedCash), notes }),
    onSuccess: () => {
      setSaved(true);
      client.invalidateQueries({ queryKey: ['daily-cash', date] });
    },
  });
  if (!enabled) return <p className="p-6">You do not have permission to view workshop accounts.</p>;
  const balances = ageing.data?.data;
  const book = cash.data?.data;
  const panel =
    'space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900';
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold">Dues & daily cash</h1>
        <p className="text-sm text-gray-500">Who owes you money, and today's cash count.</p>
      </header>
      <section className={panel} aria-label="Receivable ageing">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Who owes you money</h2>
          <button
            className="rounded border px-3 py-2 text-sm"
            disabled={ageing.isFetching}
            onClick={() => ageing.refetch()}
          >
            Refresh
          </button>
        </div>
        {ageing.isPending ? (
          <p>Loading receivables…</p>
        ) : ageing.error ? (
          <p role="alert" className="text-red-600">
            {ageing.error.message}
          </p>
        ) : (
          <>
            <p className="text-sm">
              As on {balances.date}, grouped by how many days the bill has been unpaid. Payments are
              taken off the oldest bill first.
            </p>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Object.entries({ ...balances.buckets, 'Total due': balances.totalDue }).map(
                ([key, value]) => (
                  <div key={key} className="rounded border p-3 dark:border-gray-700">
                    <dt className="text-xs text-gray-500">
                      {key === 'unaged' ? 'Old balance' : key === 'Total due' ? key : `${key} days`}
                    </dt>
                    <dd className="mt-1 font-semibold">{money(value)}</dd>
                  </div>
                ),
              )}
            </dl>
            <Table
              caption="Unpaid bills"
              columns={[
                ['invoice_number', 'Bill no.'],
                ['customer_name', 'Customer'],
                ['phone', 'Phone'],
                ['invoice_date', 'Date'],
                ['ageDays', 'Days unpaid'],
                ['outstanding', 'Still owed', money],
              ]}
              rows={balances.documents}
            />
            <h3 className="font-semibold">Customer balances</h3>
            <Table
              caption="What each customer owes"
              columns={[
                ['name', 'Customer'],
                ['phone', 'Phone'],
                ['due', 'Owes you', money],
                ['credit', 'Paid in advance', money],
                ['unaged', 'Old balance', money],
              ]}
              rows={balances.customers}
            />
          </>
        )}
      </section>
      <section className={panel} aria-label="Count today's cash">
        <h2 className="text-lg font-bold">Count today&apos;s cash</h2>
        <label className="block text-sm">
          Cash count date
          <input
            className="mt-1 block rounded border p-2 dark:bg-gray-800"
            type="date"
            max={localDate()}
            required
            value={date}
            disabled={mutation.isPending}
            onChange={(event) => {
              setDate(event.target.value);
              setCountedCash('');
              setNotes('');
              setSaved(false);
            }}
          />
        </label>
        {cash.isPending ? (
          <p>Loading cash book…</p>
        ) : cash.error ? (
          <p role="alert" className="text-red-600">
            {cash.error.message}
          </p>
        ) : (
          book && (
            <>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  ['Cash at start of day', book.opening],
                  ['Cash in', book.cashIn],
                  ['Cash out', book.cashOut],
                  ['Should be in the drawer', book.expectedClosing],
                ].map(([label, amount]) => (
                  <div key={label}>
                    <dt className="text-xs text-gray-500">{label}</dt>
                    <dd className="font-semibold">{money(amount)}</dd>
                  </div>
                ))}
              </dl>
              {hasPermission('accounting.write') && (
                <form
                  className="space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    setSaved(false);
                    mutation.mutate();
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">
                      Cash you counted (₹)
                      <input
                        className="block w-full rounded border p-2 dark:bg-gray-800"
                        type="number"
                        required
                        min="0"
                        max="100000000"
                        step="0.01"
                        value={countedCash}
                        onChange={(event) => setCountedCash(event.target.value)}
                      />
                    </label>
                    <label className="text-sm">
                      Note (needed if it does not match)
                      <input
                        className="block w-full rounded border p-2 dark:bg-gray-800"
                        required={Boolean(
                          countedCash !== '' && Number(countedCash) !== book.expectedClosing,
                        )}
                        maxLength={1000}
                        value={notes}
                        onChange={(event) => setNotes(event.target.value)}
                      />
                    </label>
                  </div>
                  {countedCash !== '' && (
                    <p className="text-sm">
                      Difference: {money(Number(countedCash) - book.expectedClosing)}
                    </p>
                  )}
                  <button
                    className="rounded border px-3 py-2 text-sm disabled:opacity-50"
                    disabled={mutation.isPending || cash.isFetching || countedCash === ''}
                  >
                    Save cash count
                  </button>
                  {mutation.error && (
                    <p role="alert" className="text-red-600">
                      {mutation.error.message}
                    </p>
                  )}
                  {saved && <p role="status">Cash count saved.</p>}
                </form>
              )}
              <p className="text-xs text-gray-500">
                Saving a count only keeps a record. It does not change your accounts.
              </p>
              <Table
                caption="Past cash counts"
                columns={[
                  ['counted_at', 'When', formatLocalTimestamp],
                  ['counted_by_name', 'Counted by'],
                  ['expected_cash', 'Should have been', money],
                  ['counted_cash', 'Counted', money],
                  ['variance', 'Difference', money],
                  ['notes', 'Notes'],
                ]}
                rows={book.counts}
              />
            </>
          )
        )}
      </section>
    </div>
  );
}
