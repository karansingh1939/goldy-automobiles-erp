import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CustomerManager from '../../src/renderer/modules/customers/CustomerManager.jsx';
import VehicleManager from '../../src/renderer/modules/vehicles/VehicleManager.jsx';
import CounterSale from '../../src/renderer/modules/sales/CounterSale.jsx';
import PurchasingManager from '../../src/renderer/modules/purchasing/PurchasingManager.jsx';
import JobCardManager from '../../src/renderer/modules/job-cards/JobCardManager.jsx';
import { useAppStore } from '../../src/renderer/shared/store/use-app-store.js';
import { api } from '../../src/renderer/shared/api/api-client.js';

beforeEach(() => {
  useAppStore.getState().setToken('test-session', { role: { name: 'Admin' } });
});

function show(Component) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Component />
    </QueryClientProvider>,
  );
}

function response(data, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

it('disables write actions for a user with read access only', async () => {
  useAppStore.getState().setToken('read-session', {
    role: { name: 'Viewer' },
    permissions: ['accounting.read', 'job_cards.read'],
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ data: [], pagination: { totalPages: 1 } })),
  );
  show(CounterSale);
  expect(screen.getByRole('button', { name: 'New counter sale' }).disabled).toBe(true);
  show(JobCardManager);
  expect(screen.getByRole('button', { name: 'Create Job Card' }).disabled).toBe(true);
});

it('clears saved optional customer fields and closes the successful edit', async () => {
  const customer = { id: 1, name: 'Customer One', email: 'wrong@example.com', credit_limit: 100 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      if (options.method === 'PATCH') Object.assign(customer, JSON.parse(options.body));
      return response({
        data: options.method === 'PATCH' ? customer : [customer],
        pagination: { totalPages: 1 },
      });
    }),
  );
  show(CustomerManager);
  const row = (await screen.findByText('Customer One')).closest('tr');
  fireEvent.click(within(row).getAllByRole('button')[0]);
  fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: '' } });
  fireEvent.change(screen.getByLabelText('Credit Limit (₹)'), { target: { value: '' } });
  fireEvent.submit(screen.getByLabelText('Customer name *').closest('form'));
  await waitFor(() => expect(customer.email).toBeNull());
  expect(customer.credit_limit).toBeNull();
  await waitFor(() => expect(screen.queryByLabelText('Customer name *')).toBeNull());
});

it('finds an owner outside the first page of customers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const query = new URL(url, 'http://localhost');
      if (query.pathname === '/api/v1/customers') {
        const filtered = query.searchParams.get('search') === 'Older Owner';
        return response({
          data: [{ id: filtered ? 21 : 1, name: filtered ? 'Older Owner' : 'Recent Owner' }],
          pagination: { totalPages: filtered ? 1 : 2 },
        });
      }
      return response({ data: [], pagination: { totalPages: 1 } });
    }),
  );
  show(VehicleManager);
  fireEvent.click(screen.getByText('Register Vehicle'));
  fireEvent.change(screen.getByLabelText('Search owners'), { target: { value: 'Older Owner' } });
  expect(await screen.findByRole('option', { name: /Older Owner/ })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Owner *'), { target: { value: '21' } });
  expect(screen.getByLabelText('Owner *').value).toBe('21');
});

it('pages purchasing records and distinguishes an API failure from an empty result', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const query = new URL(url, 'http://localhost');
      if (query.searchParams.get('page') === '2')
        return response({ error: { message: 'Database unavailable' } }, 503);
      return response({
        data: [{ id: 1, order_number: 'PO-1', subtotal: 100 }],
        pagination: { totalPages: 2 },
      });
    }),
  );
  show(PurchasingManager);
  fireEvent.click(screen.getByText('Orders (optional)'));
  await screen.findByText('PO-1');
  fireEvent.click(screen.getByText('Next page'));
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('Database unavailable'),
  );
  expect(screen.queryByText('No purchase orders open.')).toBeNull();
});

it('does not let an old customer lookup overwrite a newer phone lookup', async () => {
  let finishOld;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (url.includes('phone=1111111111'))
        return new Promise((resolve) => {
          finishOld = () => resolve(response({ data: { id: 1, name: 'Old Customer' } }));
        });
      if (url.includes('phone=2222222222'))
        return response({ data: { id: 2, name: 'Current Customer' } });
      return response({ data: [], pagination: { totalPages: 1 } });
    }),
  );
  show(JobCardManager);
  fireEvent.click(screen.getByText('Create Job Card'));
  fireEvent.change(screen.getByLabelText('Mobile Number *'), { target: { value: '1111111111' } });
  fireEvent.change(screen.getByLabelText('Mobile Number *'), { target: { value: '2222222222' } });
  await waitFor(() =>
    expect(screen.getByLabelText('Customer Name *').value).toBe('Current Customer'),
  );
  await act(async () => finishOld());
  expect(screen.getByLabelText('Customer Name *').value).toBe('Current Customer');
  fireEvent.change(screen.getByLabelText('Mobile Number *'), { target: { value: '222' } });
  expect(screen.queryByText('Existing Customer Found')).toBeNull();
});

it('loads the next page of job cards instead of hiding older repairs', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const query = new URL(url, 'http://localhost');
      const page = query.searchParams.get('page') || '1';
      return response({
        data:
          query.pathname === '/api/v1/job-cards'
            ? [
                {
                  id: Number(page),
                  job_card_number: `JC-${page}`,
                  registration_number: `CAR-${page}`,
                  status: 'OPEN',
                },
              ]
            : [],
        pagination: { totalPages: 2 },
      });
    }),
  );
  show(JobCardManager);
  await screen.findByText('JC-1');
  fireEvent.click(screen.getByText('Next page'));
  expect(await screen.findByText('JC-2')).toBeTruthy();
  expect(screen.queryByText('JC-1')).toBeNull();
});

it('reports failed job-card finalization so staff can correct the problem', async () => {
  const card = { id: 1, job_card_number: 'JC-FAIL', status: 'DRAFT', parts: [], labour: [] };
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: url.endsWith('/job-cards/1') ? card : url.includes('/job-cards?') ? [card] : [],
    pagination: { totalPages: 1 },
  }));
  vi.spyOn(api, 'post').mockRejectedValue(new Error('Credit limit exceeded'));
  show(JobCardManager);
  fireEvent.click(await screen.findByText('JC-FAIL'));
  fireEvent.click(await screen.findByText('Make bill'));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByText('Confirm & post invoice'));
  await waitFor(() =>
    expect(
      useAppStore
        .getState()
        .notifications.some(
          (notification) =>
            notification.type === 'error' && notification.message === 'Credit limit exceeded',
        ),
    ).toBe(true),
  );
});

it('records a cash payment chosen while billing a job card', async () => {
  const card = { id: 1, job_card_number: 'JC-PAY', status: 'DRAFT', parts: [], labour: [] };
  vi.spyOn(api, 'get').mockImplementation(async (url) => ({
    data: url.endsWith('/job-cards/1')
      ? card
      : url.includes('/job-cards?')
        ? [card]
        : url.includes('/money-accounts')
          ? [{ id: 1, name: 'Cash in Hand', kind: 'CASH', balance: 0 }]
          : [],
    pagination: { totalPages: 1 },
  }));
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) =>
    url.endsWith('/finalize')
      ? {
          data: {
            invoice: {
              customer_id: 9,
              invoice_date: '2026-11-11',
              grand_total: 590,
              invoice_number: 'INV/26-27/0001',
            },
          },
        }
      : { data: {} },
  );
  show(JobCardManager);
  fireEvent.click(await screen.findByText('JC-PAY'));
  fireEvent.click(await screen.findByText('Make bill'));
  fireEvent.change(await screen.findByLabelText('Payment'), { target: { value: 'CASH' } });
  fireEvent.click(screen.getByText('Confirm & post invoice'));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/v1/accounting/receipts',
      expect.objectContaining({ customerId: 9, amount: 590, paymentMode: 'CASH' }),
    ),
  );
});

it('makes a cash counter sale and pays that bill', async () => {
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/v1/inventory/items/3/batches'))
      return { data: [{ id: 8, warehouse_id: 2, quantity: 5 }] };
    if (url.startsWith('/api/v1/inventory/items/3'))
      return {
        data: { id: 3, item_name: 'Oil', selling_price: 400, gst_rate: 18, current_quantity: 5 },
      };
    if (url.startsWith('/api/v1/inventory/items'))
      return {
        data: [{ id: 3, item_name: 'Oil', sku: 'OIL', current_quantity: 5 }],
        pagination: { totalPages: 1 },
      };
    if (url.includes('/money-accounts')) return { data: [{ id: 1, kind: 'CASH', name: 'Cash' }] };
    return { data: [], pagination: { totalPages: 1 } };
  });
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) =>
    url.endsWith('/direct-invoices')
      ? {
          data: {
            invoiceId: 11,
            invoiceNumber: 'CS/26-27/0001',
            invoiceDate: '2026-11-27',
            customerId: 5,
            grandTotal: 472,
          },
        }
      : { data: {} },
  );
  show(CounterSale);
  fireEvent.click(screen.getByRole('button', { name: 'New counter sale' }));
  await screen.findByRole('option', { name: /Oil \(OIL\)/ });
  fireEvent.change(screen.getByLabelText('Item 1'), { target: { value: '3' } });
  await waitFor(() => expect(screen.getByLabelText('Price (₹)').value).toBe('400'));
  fireEvent.click(screen.getByRole('button', { name: 'Make bill' }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/v1/accounting/receipts',
      expect.objectContaining({
        customerId: 5,
        amount: 472,
        paymentMode: 'CASH',
        allocations: [{ documentType: 'direct_invoice', documentId: 11, allocatedAmount: 472 }],
      }),
    ),
  );
  expect(post).toHaveBeenCalledWith(
    '/api/v1/accounting/direct-invoices',
    expect.objectContaining({
      items: [expect.objectContaining({ itemId: 3, warehouseId: 2, unitPrice: 400 })],
    }),
  );
});
