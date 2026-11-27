import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus } from 'lucide-react';
import { api } from '../api/api-client.js';
import { useAppStore } from '../store/use-app-store.js';
import { validateEmail, validatePhone, validateGstin } from '../utils/validation.js';
import { usePermissions } from '../hooks/use-permissions.js';
import DataTable from './DataTable.jsx';
import ServerPagination from './ServerPagination.jsx';
import { TextField, Modal, FormButtons, RowActions } from './FormParts.jsx';

const PAGE_SIZE = 15;
const BASE_FIELDS = ['name', 'phone', 'email', 'gstin', 'address', 'city', 'state', 'pincode'];

/**
 * List, search, add, edit and delete screen for people the workshop deals
 * with (customers, suppliers). `config` gives the words, the API path and any
 * extra field such as a credit limit.
 */
export default function PartyScreen({ config }) {
  const { resource, permission, words, icon, extraField, extraColumn } = config;
  const queryClient = useQueryClient();
  const addNotification = useAppStore((state) => state.addNotification);
  const openDialog = useAppStore((state) => state.openDialog);
  const canWrite = usePermissions().hasPermission(permission);
  const blank = () =>
    Object.fromEntries(
      [...BASE_FIELDS, ...(extraField ? [extraField.key] : [])].map((k) => [k, '']),
    );

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null: closed, {}: new, row: edit
  const [form, setForm] = useState(blank);
  const set = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  const list = useQuery({
    queryKey: [resource, search, page],
    queryFn: () =>
      api.get(
        `/api/v1/${resource}?${new URLSearchParams({ search, page, pageSize: PAGE_SIZE, sortBy: 'name', sortOrder: 'asc' })}`,
      ),
  });
  const totalPages = list.data?.pagination?.totalPages || 1;

  const after = (message) => () => {
    queryClient.invalidateQueries({ queryKey: [resource] });
    addNotification(message, 'success');
    setEditing(null);
  };
  const failed = (fallback) => (err) => addNotification(err.message || fallback, 'error');
  const save = useMutation({
    mutationFn: ({ id, payload }) =>
      id
        ? api.patch(`/api/v1/${resource}/${id}`, payload)
        : api.post(`/api/v1/${resource}`, payload),
    onSuccess: (_, { id }) => after(id ? words.updated : words.created)(),
    onError: failed(`Could not save the ${words.one}.`),
  });
  const remove = useMutation({
    mutationFn: (id) => api.del(`/api/v1/${resource}/${id}`),
    onSuccess: after(words.deleted),
    onError: failed(`Could not delete the ${words.one}.`),
  });

  const open = (row) => {
    setForm(row ? Object.fromEntries(Object.keys(blank()).map((k) => [k, row[k] ?? ''])) : blank());
    setEditing(row || {});
  };

  const handleSave = (event) => {
    event.preventDefault();
    if (!form.name.trim()) return addNotification(`${words.nameLabel} is required.`, 'error');
    if (form.email && !validateEmail(form.email))
      return addNotification('Please enter a valid email address.', 'error');
    if (form.phone && !validatePhone(form.phone))
      return addNotification('Phone number must be exactly 10 digits.', 'error');
    if (form.gstin && !validateGstin(form.gstin))
      return addNotification('GSTIN must be a valid 15-character number.', 'error');
    const payload = Object.fromEntries(BASE_FIELDS.map((k) => [k, form[k] || null]));
    payload.name = form.name;
    if (extraField)
      payload[extraField.key] = form[extraField.key] !== '' ? Number(form[extraField.key]) : null;
    save.mutate({ id: editing.id, payload });
  };

  const columns = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: (info) => (
        <span className="font-semibold text-gray-900 dark:text-white">{info.getValue()}</span>
      ),
    },
    { accessorKey: 'phone', header: 'Phone', cell: (info) => info.getValue() || '-' },
    {
      accessorKey: 'gstin',
      header: 'GSTIN',
      cell: (info) => <span className="font-mono text-xs">{info.getValue() || '-'}</span>,
    },
    {
      accessorKey: 'city',
      header: 'City/State',
      cell: ({ row }) => [row.original.city, row.original.state].filter(Boolean).join(', ') || '-',
    },
    ...(extraColumn ? [extraColumn] : []),
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <RowActions
          disabled={!canWrite}
          onEdit={() => open(row.original)}
          onDelete={() =>
            openDialog({
              title: `Delete ${words.title}`,
              message: `Are you sure you want to permanently delete ${words.one} "${row.original.name}"? This action cannot be undone.`,
              onConfirm: () => remove.mutate(row.original.id),
            })
          }
        />
      ),
    },
  ];

  const field = (key, label, props = {}) => (
    <TextField
      id={`${words.one}-${key}-field`}
      label={label}
      value={form[key]}
      onChange={set(key)}
      {...props}
    />
  );

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {words.heading}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{words.description}</p>
        </div>
        <button
          onClick={() => open(null)}
          disabled={!canWrite}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {words.add}
        </button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <input
          type="text"
          aria-label={`Search ${words.heading.toLowerCase()}`}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Filter by name, phone, or GSTIN..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white rounded-lg text-sm focus-ring"
        />
      </div>

      <DataTable
        columns={columns}
        data={list.data?.data || []}
        isLoading={list.isLoading}
        error={list.error}
        enablePagination={false}
        emptyStateMessage={`No matching ${words.one} records found.`}
      />
      {totalPages > 1 && (
        <ServerPagination page={page} totalPages={totalPages} onChange={setPage} />
      )}

      {editing && (
        <Modal
          title={editing.id ? `Edit ${words.one}` : `New ${words.one}`}
          icon={icon}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={handleSave} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              {field('name', `${words.nameLabel} *`, { required: true, className: 'col-span-2' })}
              {field('phone', 'Phone Number')}
              {field('email', 'Email Address', { type: 'email' })}
              {field('gstin', 'GSTIN Number (15-digit)', {
                className: 'col-span-2',
                inputClassName: 'font-mono',
                onChange: (e) => setForm({ ...form, gstin: e.target.value.toUpperCase() }),
              })}
              {field('address', 'Billing Address', { className: 'col-span-2' })}
              {field('city', 'City')}
              {field('state', 'State')}
              {field('pincode', 'PIN Code')}
              {extraField && field(extraField.key, extraField.label, { type: 'number' })}
            </div>
            <FormButtons
              onCancel={() => setEditing(null)}
              saving={save.isPending}
              saveLabel={words.save}
            />
          </form>
        </Modal>
      )}
    </div>
  );
}
