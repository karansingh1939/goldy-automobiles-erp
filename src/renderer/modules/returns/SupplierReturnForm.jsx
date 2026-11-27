import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../shared/api/api-client.js';
import RemoteSelect from '../../shared/components/RemoteSelect.jsx';
import { useAppStore } from '../../shared/store/use-app-store.js';
import { localDate } from '../../../../public/local-date.js';

const input =
  'mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800';

/**
 * Send parts back to a supplier: choose the supplier bill they came on, the
 * item and how many. Saved as a draft; approving it takes the stock out and
 * lowers what you owe that supplier.
 */
export default function SupplierReturnForm({ onDone }) {
  const client = useQueryClient();
  const addNotification = useAppStore((state) => state.addNotification);
  const [receiptId, setReceiptId] = useState('');
  const [lineId, setLineId] = useState('');
  const [qty, setQty] = useState('1');
  const receipt = useQuery({
    queryKey: ['supplier-return-bill', receiptId],
    queryFn: () => api.get(`/api/v1/purchases/receipts/${receiptId}`),
    enabled: Boolean(receiptId),
  });
  const bill = receipt.data?.data;
  const lines = (bill?.items || []).filter((line) => line.batch_id);
  const line = lines.find((row) => String(row.id) === String(lineId));
  const save = useMutation({
    mutationFn: () =>
      api.post('/api/v1/returns/supplier', {
        supplierId: bill.supplier_id,
        returnDate: localDate(),
        items: [{ itemId: line.item_id, batchId: line.batch_id, quantity: Number(qty) }],
      }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['supplier-returns'] });
      addNotification(
        'Supplier return saved as a draft. Approve it to send the stock back.',
        'success',
      );
      onDone();
    },
    onError: (error) => addNotification(error.message || 'Could not save the return.', 'error'),
  });
  return (
    <form
      className="space-y-3 rounded-xl border bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="text-lg font-semibold">Send parts back to a supplier</h2>
      <div>
        <label htmlFor="supplier-return-bill" className="block text-sm font-medium">
          Supplier bill the parts came on
        </label>
        <RemoteSelect
          id="supplier-return-bill"
          endpoint="/api/v1/purchases/receipts"
          queryKey="purchase-receipts"
          searchLabel="Find supplier bill"
          value={receiptId}
          onChange={(value) => {
            setReceiptId(value);
            setLineId('');
          }}
          optionLabel={(row) =>
            `Bill ${row.receipt_number} · ${row.supplier_name || ''} · ${row.receipt_date || ''}`
          }
        />
      </div>
      <label className="block text-sm font-medium">
        Item
        <select
          className={input}
          required
          value={lineId}
          disabled={!lines.length}
          onChange={(e) => setLineId(e.target.value)}
        >
          <option value="">Choose the item...</option>
          {lines.map((row) => (
            <option key={row.id} value={row.id}>
              {row.item_name} · bought {row.quantity} at ₹{Number(row.purchase_cost).toFixed(2)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium">
        How many to send back
        <input
          className={input}
          type="number"
          min="0.01"
          step="0.01"
          max={line?.quantity}
          required
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending || !line}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          Save return
        </button>
        <button type="button" className="rounded-lg border px-4 py-2 text-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
