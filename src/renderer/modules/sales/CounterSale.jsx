import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/api-client.js';
import RemoteSelect from '../../shared/components/RemoteSelect.jsx';
import { useAppStore } from '../../shared/store/use-app-store.js';
import { usePermissions } from '../../shared/hooks/use-permissions.js';
import { localDate } from '../../../../public/local-date.js';
import InvoiceTaxSummary from '../billing/InvoiceTaxSummary.jsx';
import { amountInWords } from '../billing/amount-in-words.js';
import { money } from '../../shared/format.js';
import { bankAccounts, useMoneyAccounts } from '../../shared/components/MoneyWarning.jsx';

/**
 * Counter sale: sell parts or oil over the counter without a job card.
 * Creates a GST bill (CS/26-27/0001), takes the stock out and, when paid now,
 * records the payment against this bill.
 */
const input =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-base dark:border-gray-700 dark:bg-gray-800';
const STATUS = {
  PAID: ['Paid', 'bg-green-100 text-green-800'],
  PARTIALLY_PAID: ['Part paid', 'bg-amber-100 text-amber-800'],
  UNPAID: ['Unpaid', 'bg-red-100 text-red-800'],
  CANCELLED: ['Cancelled', 'bg-gray-200 text-gray-600'],
};
const emptyLine = () => ({ key: Math.random(), itemId: '', name: '', qty: 1, price: '', gst: 18 });

function SaleLine({ line, index, onChange, onRemove, canRemove }) {
  const pick = async (itemId) => {
    onChange({ itemId, warehouseId: '', stock: null });
    if (!itemId) return;
    const [item, batches] = await Promise.all([
      api.get(`/api/v1/inventory/items/${itemId}`),
      api.get(`/api/v1/inventory/items/${itemId}/batches`),
    ]);
    // Sell from the godown that has the oldest stock of this item.
    const batch = (batches?.data || []).find((row) => Number(row.quantity) > 0);
    onChange({
      itemId,
      name: item?.data?.item_name || '',
      price: item?.data?.selling_price ?? '',
      gst: item?.data?.gst_rate ?? 18,
      warehouseId: batch?.warehouse_id || '',
      stock: Number(item?.data?.current_quantity || 0),
    });
  };
  return (
    <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-6">
      <div className="sm:col-span-3">
        <label htmlFor={`counter-item-${index}`} className="block text-sm font-medium">
          Item {index + 1}
        </label>
        <RemoteSelect
          id={`counter-item-${index}`}
          endpoint="/api/v1/inventory/items"
          queryKey="counter-items"
          searchLabel={`Find item ${index + 1}`}
          value={line.itemId}
          onChange={pick}
          optionLabel={(row) => `${row.item_name} (${row.sku}) · in stock ${row.current_quantity}`}
        />
        {line.itemId && line.stock !== null && Number(line.qty) > line.stock && (
          <p role="alert" className="mt-1 text-sm text-red-700">
            Only {line.stock} in stock.
          </p>
        )}
      </div>
      <label className="text-sm font-medium">
        Quantity
        <input
          className={input}
          type="number"
          min="0.01"
          step="0.01"
          required
          value={line.qty}
          onChange={(e) => onChange({ qty: e.target.value })}
        />
      </label>
      <label className="text-sm font-medium">
        Price (₹)
        <input
          className={input}
          type="number"
          min="0"
          step="0.01"
          required
          value={line.price}
          onChange={(e) => onChange({ price: e.target.value })}
        />
      </label>
      <label className="text-sm font-medium">
        GST %
        <input
          className={input}
          type="number"
          min="0"
          max="28"
          step="0.01"
          required
          value={line.gst}
          onChange={(e) => onChange({ gst: e.target.value })}
        />
      </label>
      {canRemove && (
        <button
          type="button"
          className="text-sm text-red-700 underline sm:col-span-6 sm:text-left"
          onClick={onRemove}
        >
          Remove item {index + 1}
        </button>
      )}
    </div>
  );
}

function NewSale({ onDone }) {
  const client = useQueryClient();
  const addNotification = useAppStore((state) => state.addNotification);
  const [customerId, setCustomerId] = useState('');
  const [date, setDate] = useState(localDate());
  const [lines, setLines] = useState([emptyLine()]);
  const [payMode, setPayMode] = useState('CASH');
  const [bankId, setBankId] = useState('');
  const banks = bankAccounts(useMoneyAccounts());
  const update = (key, patch) =>
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const total = lines.reduce((sum, line) => {
    const taxable = Number(line.qty || 0) * Number(line.price || 0);
    return sum + taxable * (1 + Number(line.gst || 0) / 100);
  }, 0);

  const save = useMutation({
    mutationFn: async () => {
      const created = await api.post('/api/v1/accounting/direct-invoices', {
        customerId: customerId ? Number(customerId) : undefined,
        invoiceDate: date,
        items: lines.map((line) => ({
          itemId: Number(line.itemId),
          warehouseId: Number(line.warehouseId) || undefined,
          description: line.name,
          quantity: Number(line.qty),
          unitPrice: Number(line.price),
          gstRate: Number(line.gst),
        })),
      });
      const bill = created.data;
      if (payMode !== 'LATER') {
        const bank = Number(bankId) || (banks.length === 1 ? banks[0].id : null);
        await api.post('/api/v1/accounting/receipts', {
          customerId: bill.customerId,
          receiptDate: bill.invoiceDate,
          amount: Number(bill.grandTotal),
          ...(payMode === 'CASH'
            ? { paymentMode: 'CASH' }
            : { paymentMode: 'BANK', bankLedgerId: bank }),
          narration: `${payMode} payment for ${bill.invoiceNumber}`,
          allocations: [
            {
              documentType: 'direct_invoice',
              documentId: bill.invoiceId,
              allocatedAmount: Number(bill.grandTotal),
            },
          ],
        });
      }
      return bill;
    },
    onSuccess: (bill) => {
      for (const key of ['counter-sales', 'money-accounts', 'dashboard', 'counter-items'])
        client.invalidateQueries({ queryKey: [key] });
      addNotification(`Bill ${bill.invoiceNumber} made.`, 'success');
      onDone(bill.invoiceId);
    },
    onError: (error) => addNotification(error.message || 'Could not make the bill.', 'error'),
  });

  const needsBank = payMode === 'UPI' || payMode === 'CARD';
  return (
    <form
      className="space-y-4 rounded-xl border bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-lg font-semibold">New counter sale</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="counter-customer" className="block text-sm font-medium">
            Customer (leave empty for walk-in)
          </label>
          <RemoteSelect
            id="counter-customer"
            endpoint="/api/v1/customers"
            queryKey="customers"
            searchLabel="Find customer by name or phone"
            placeholder="Walk-in customer"
            required={false}
            value={customerId}
            onChange={setCustomerId}
            optionLabel={(row) => `${row.name}${row.phone ? ` · ${row.phone}` : ''}`}
          />
        </div>
        <label className="text-sm font-medium">
          Date
          <input
            className={input}
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>
      {lines.map((line, index) => (
        <SaleLine
          key={line.key}
          line={line}
          index={index}
          canRemove={lines.length > 1}
          onChange={(patch) => update(line.key, patch)}
          onRemove={() => setLines((rows) => rows.filter((row) => row.key !== line.key))}
        />
      ))}
      <button
        type="button"
        className="rounded-lg border px-4 py-2"
        onClick={() => setLines((rows) => [...rows, emptyLine()])}
      >
        + Add another item
      </button>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Payment
          <select className={input} value={payMode} onChange={(e) => setPayMode(e.target.value)}>
            <option value="CASH">Paid in cash</option>
            <option value="UPI">Paid by UPI</option>
            <option value="CARD">Paid by card</option>
            <option value="LATER">Pay later (credit)</option>
          </select>
        </label>
        {needsBank && banks.length > 1 && (
          <label className="text-sm font-medium">
            Into bank
            <select
              className={input}
              required
              value={bankId}
              onChange={(e) => setBankId(e.target.value)}
            >
              <option value="">Choose bank...</option>
              {banks.map((bank) => (
                <option key={bank.id} value={bank.id}>
                  {bank.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {needsBank && banks.length === 0 && (
        <p role="alert" className="text-sm text-red-700">
          Add your bank account under Money In / Out first.
        </p>
      )}
      <p className="text-right text-lg font-semibold">Total (with GST): {money(total)}</p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending || lines.some((line) => !line.itemId)}
          className="rounded-lg bg-brand-600 px-5 py-2 font-semibold text-white disabled:opacity-60"
        >
          Make bill
        </button>
        <button type="button" className="rounded-lg border px-5 py-2" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function SaleBill({ id, onClose }) {
  const client = useQueryClient();
  const addNotification = useAppStore((state) => state.addNotification);
  const { hasPermission } = usePermissions();
  const [confirm, setConfirm] = useState(false);
  const bill = useQuery({
    queryKey: ['counter-sales', id],
    queryFn: () => api.get(`/api/v1/accounting/direct-invoices/${id}`),
  });
  const invoice = bill.data?.data;
  const company = useQuery({
    queryKey: ['invoice-company'],
    queryFn: () => api.get('/api/v1/settings/company'),
  });
  const customer = useQuery({
    queryKey: ['customer', invoice?.customer_id],
    queryFn: () => api.get(`/api/v1/customers/${invoice.customer_id}`),
    enabled: Boolean(invoice?.customer_id),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/api/v1/accounting/direct-invoices/${id}/cancel`, {}),
    onSuccess: (result) => {
      setConfirm(false);
      const advance = Number(result?.data?.advance_kept || 0);
      addNotification(
        advance > 0
          ? `Bill cancelled. Stock is back. ₹${advance.toFixed(2)} already paid is kept as advance for this customer.`
          : 'Bill cancelled. Stock is back and the sale is removed.',
        'success',
      );
      for (const key of ['counter-sales', 'money-accounts', 'dashboard'])
        client.invalidateQueries({ queryKey: [key] });
    },
  });
  if (bill.isPending) return <p>Loading bill...</p>;
  if (bill.error) return <p role="alert">{bill.error.message}</p>;
  const c = company.data?.data || {};
  const items = (invoice.items || []).map((item) => ({
    ...item,
    line_revenue: Number(item.unit_price) * Number(item.quantity),
  }));
  return (
    <section className="space-y-3">
      <style>{`@media print { body * { visibility:hidden; } #counter-print, #counter-print * { visibility:visible; } #counter-print {position:absolute;left:0;top:0;width:100%;background:white;color:black;} }`}</style>
      <div className="flex flex-wrap gap-2">
        <button className="rounded-lg border px-4 py-2" onClick={() => window.print()}>
          Print bill
        </button>
        {invoice.status !== 'CANCELLED' && hasPermission('accounting.write') && (
          <button className="rounded-lg border px-4 py-2" onClick={() => setConfirm(true)}>
            Cancel bill
          </button>
        )}
        <button className="rounded-lg border px-4 py-2" onClick={onClose}>
          Close
        </button>
      </div>
      {confirm && (
        <div role="alertdialog" className="rounded-lg border border-red-400 p-4">
          <p className="mb-3">
            Cancelling puts the items back in stock and removes this sale. If the customer already
            paid, that money is kept as advance for them.
          </p>
          <div className="flex gap-2">
            <button
              className="rounded-lg bg-red-600 px-4 py-2 font-semibold text-white"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Confirm cancellation
            </button>
            <button className="rounded-lg border px-4 py-2" onClick={() => setConfirm(false)}>
              Keep bill
            </button>
          </div>
        </div>
      )}
      {cancel.error && (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">
          {cancel.error.message}
        </p>
      )}
      <article id="counter-print" className="space-y-4 rounded border bg-white p-6 text-gray-900">
        <header>
          <h2 className="text-xl font-bold">{c.name || 'GOLDY AUTOMOBILE'}</h2>
          <p>{c.address}</p>
          <p>
            {c.phone} · GSTIN: {c.gstin || '—'} · State: {c.state || '—'}
            {c.stateCode ? ` (${c.stateCode})` : ''}
          </p>
          <h3 className="font-bold">
            {c.gstin ? 'TAX INVOICE' : 'INVOICE'} · {invoice.invoice_number}
            {invoice.status === 'CANCELLED' ? ' · CANCELLED' : ''}
          </h3>
          <p>Date: {invoice.invoice_date} · Original for recipient · Reverse charge: No</p>
        </header>
        <p>
          Bill to: {customer.data?.data?.name || 'Walk-in customer'}
          {customer.data?.data?.phone ? ` · ${customer.data.data.phone}` : ''}
          {customer.data?.data?.gstin && (
            <>
              <br />
              Customer GSTIN: {customer.data.data.gstin}
            </>
          )}
          <br />
          Place of supply: {customer.data?.data?.state || c.state || '—'}
        </p>
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              {['Item', 'HSN', 'Qty', 'Rate', 'Taxable', 'GST %', 'Tax', 'Total'].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.item_name || item.description}</td>
                <td>{item.hsn_code || '—'}</td>
                <td>{item.quantity}</td>
                <td>{money(item.unit_price)}</td>
                <td>{money(item.line_revenue)}</td>
                <td>{item.gst_rate}%</td>
                <td>{money(item.gst_amount)}</td>
                <td>{money(item.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <InvoiceTaxSummary items={items} />
        <p>Total amount in words: {amountInWords(invoice.grand_total)}</p>
        <dl className="grid grid-cols-2 gap-2">
          <dt>Taxable subtotal</dt>
          <dd>{money(invoice.subtotal)}</dd>
          <dt>GST total</dt>
          <dd>{money(invoice.gst_total)}</dd>
          <dt>Grand total</dt>
          <dd className="font-bold">{money(invoice.grand_total)}</dd>
          <dt>Amount paid</dt>
          <dd>{money(invoice.amount_paid)}</dd>
        </dl>
        <p className="pt-8 text-right">
          For {c.name || 'GOLDY AUTOMOBILE'}
          <br />
          Authorised signatory
        </p>
      </article>
    </section>
  );
}

export default function CounterSale() {
  const [mode, setMode] = useState('list'); // list | new | <bill id>
  const { hasPermission } = usePermissions();
  const list = useQuery({
    queryKey: ['counter-sales', 'list'],
    queryFn: () => api.get('/api/v1/accounting/direct-invoices'),
    enabled: mode === 'list',
  });
  const rows = Array.isArray(list.data?.data) ? list.data.data : [];
  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Counter Sale</h1>
          <p className="text-gray-500">
            Sell parts or oil over the counter without a job card. Stock and accounts update by
            themselves.
          </p>
        </div>
        {mode === 'list' && (
          <button
            className="rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white disabled:opacity-50"
            disabled={!hasPermission('accounting.write')}
            onClick={() => setMode('new')}
          >
            New counter sale
          </button>
        )}
      </header>
      {mode === 'new' && <NewSale onDone={(id) => setMode(id || 'list')} />}
      {typeof mode === 'number' && <SaleBill id={mode} onClose={() => setMode('list')} />}
      {mode === 'list' && (
        <section className="rounded-xl border bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
          {list.error && <p role="alert">{list.error.message}</p>}
          {!rows.length && !list.isPending ? (
            <p className="p-5">No counter sales yet. Press “New counter sale” to make one.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b">
                  {['Bill no.', 'Date', 'Customer', 'Total', 'Payment', ''].map((h) => (
                    <th key={h} className="p-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const [label, style] = STATUS[row.status] || [row.status, ''];
                  return (
                    <tr key={row.id} className="border-b">
                      <td className="p-3 font-mono">{row.invoice_number}</td>
                      <td className="p-3">{row.invoice_date}</td>
                      <td className="p-3">{row.customer_name}</td>
                      <td className="p-3">{money(row.grand_total)}</td>
                      <td className="p-3">
                        <span className={`rounded px-2 py-1 text-xs font-semibold ${style}`}>
                          {label}
                        </span>
                      </td>
                      <td className="p-3">
                        <button
                          className="rounded border px-3 py-1"
                          aria-label={`Open ${row.invoice_number}`}
                          onClick={() => setMode(row.id)}
                        >
                          Open
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
