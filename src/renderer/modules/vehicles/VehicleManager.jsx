import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Car } from 'lucide-react';
import { api } from '../../shared/api/api-client.js';
import { useAppStore } from '../../shared/store/use-app-store.js';
import { validateVehicleReg } from '../../shared/utils/validation.js';
import { usePermissions } from '../../shared/hooks/use-permissions.js';
import RemoteSelect from '../../shared/components/RemoteSelect.jsx';
import DataTable from '../../shared/components/DataTable.jsx';
import ServerPagination from '../../shared/components/ServerPagination.jsx';
import { TextField, Modal, FormButtons, RowActions } from '../../shared/components/FormParts.jsx';

const PAGE_SIZE = 15;
const blank = () => ({
  customer_id: '',
  registration_number: '',
  make: '',
  model: '',
  variant: '',
  fuel_type: 'Petrol',
  year: '',
  vin: '',
  engine_number: '',
  chassis_number: '',
  odometer_reading: '',
});

/** Every car with its owner; add, edit or delete one. */
export default function VehicleManager() {
  const queryClient = useQueryClient();
  const addNotification = useAppStore((state) => state.addNotification);
  const openDialog = useAppStore((state) => state.openDialog);
  const canWrite = usePermissions().hasPermission('vehicles.write');

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null); // null: closed, {}: new, row: edit
  const [form, setForm] = useState(blank);
  const set =
    (key, upper = false) =>
    (event) =>
      setForm({ ...form, [key]: upper ? event.target.value.toUpperCase() : event.target.value });

  const list = useQuery({
    queryKey: ['vehicles', search, page],
    queryFn: () =>
      api.get(
        `/api/v1/vehicles?${new URLSearchParams({ search, page, pageSize: PAGE_SIZE, sortBy: 'registration_number', sortOrder: 'asc' })}`,
      ),
  });
  const totalPages = list.data?.pagination?.totalPages || 1;

  const after = (message) => () => {
    queryClient.invalidateQueries({ queryKey: ['vehicles'] });
    addNotification(message, 'success');
    setEditing(null);
  };
  const save = useMutation({
    mutationFn: ({ id, payload }) =>
      id ? api.patch(`/api/v1/vehicles/${id}`, payload) : api.post('/api/v1/vehicles', payload),
    onSuccess: (_, { id }) =>
      after(id ? 'Vehicle details updated.' : 'Vehicle registered successfully.')(),
    onError: (err) => addNotification(err.message || 'Could not save the vehicle.', 'error'),
  });
  const remove = useMutation({
    mutationFn: (id) => api.del(`/api/v1/vehicles/${id}`),
    onSuccess: after('Vehicle deleted.'),
    onError: (err) => addNotification(err.message || 'Could not delete the vehicle.', 'error'),
  });

  const open = (row) => {
    setForm(
      row
        ? Object.fromEntries(
            Object.entries(blank()).map(([key, empty]) => [key, row[key] ?? empty]),
          )
        : blank(),
    );
    setEditing(row || {});
  };

  const handleSave = (event) => {
    event.preventDefault();
    if (!form.customer_id) return addNotification('Choose the owner.', 'error');
    if (!form.registration_number.trim())
      return addNotification('Registration number is required.', 'error');
    if (!form.make.trim()) return addNotification('Vehicle make is required.', 'error');
    if (!form.model.trim()) return addNotification('Vehicle model is required.', 'error');
    if (!validateVehicleReg(form.registration_number))
      return addNotification(
        'Invalid Indian vehicle registration format (e.g. HR26AB1234).',
        'error',
      );
    const orNull = (value) => value || null;
    const numberOrNull = (value) => (value !== '' ? Number(value) : null);
    save.mutate({
      id: editing.id,
      payload: {
        customer_id: Number(form.customer_id),
        registration_number: form.registration_number.replace(/[-\s]/g, '').toUpperCase(),
        make: form.make,
        model: form.model,
        variant: orNull(form.variant),
        fuel_type: form.fuel_type,
        year: numberOrNull(form.year),
        vin: orNull(form.vin),
        engine_number: orNull(form.engine_number),
        chassis_number: orNull(form.chassis_number),
        // Blank means not read yet; the database keeps 0 then.
        odometer_reading: Number(form.odometer_reading) || 0,
      },
    });
  };

  const columns = [
    {
      accessorKey: 'registration_number',
      header: 'Car number',
      cell: (info) => (
        <span className="font-mono font-bold text-gray-900 dark:text-white">{info.getValue()}</span>
      ),
    },
    {
      accessorKey: 'make',
      header: 'Make & Model',
      cell: ({ row }) => `${row.original.make} ${row.original.model} ${row.original.variant || ''}`,
    },
    {
      accessorKey: 'fuel_type',
      header: 'Fuel Type',
      cell: (info) => <span className="capitalize">{info.getValue()}</span>,
    },
    {
      accessorKey: 'odometer_reading',
      header: 'Odometer',
      cell: (info) => (info.getValue() ? `${info.getValue().toLocaleString('en-IN')} km` : '-'),
    },
    {
      accessorKey: 'customer_name',
      header: 'Owner',
      cell: (info) => (
        <span className="text-brand-650 dark:text-brand-400 font-semibold">
          {info.getValue() || `ID: ${info.row.original.customer_id}`}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <RowActions
          disabled={!canWrite}
          onEdit={() => open(row.original)}
          onDelete={() =>
            openDialog({
              title: 'Delete Vehicle',
              message: `Are you sure you want to permanently delete vehicle "${row.original.registration_number}"? This action cannot be undone.`,
              onConfirm: () => remove.mutate(row.original.id),
            })
          }
        />
      ),
    },
  ];

  const field = (key, label, props = {}) => (
    <TextField
      id={`vehicle-${key === 'registration_number' ? 'reg' : key.replace('_number', '').replace('_reading', '')}-field`}
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
            Vehicles
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Every car with its owner and last odometer reading.
          </p>
        </div>
        <button
          onClick={() => open(null)}
          disabled={!canWrite}
          className="flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Register Vehicle
        </button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
        <input
          type="text"
          aria-label="Search vehicles"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          placeholder="Search by registration number, make, model..."
          className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white rounded-lg text-sm focus-ring"
        />
      </div>

      <DataTable
        columns={columns}
        data={list.data?.data || []}
        isLoading={list.isLoading}
        error={list.error}
        enablePagination={false}
        emptyStateMessage="No matching vehicle accounts found."
      />
      {totalPages > 1 && (
        <ServerPagination page={page} totalPages={totalPages} onChange={setPage} />
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Edit Vehicle' : 'Register Customer Vehicle'}
          icon={Car}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={handleSave} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label
                  htmlFor="vehicle-owner-select"
                  className="block text-xs font-semibold text-gray-600 dark:text-gray-400"
                >
                  Owner *
                </label>
                <RemoteSelect
                  id="vehicle-owner-select"
                  endpoint="/api/v1/customers"
                  queryKey="customers"
                  value={form.customer_id}
                  onChange={(value) => setForm({ ...form, customer_id: value })}
                  searchLabel="Search owners"
                  placeholder="Select owner profile..."
                  optionLabel={(c) => `${c.name} (${c.phone || 'No Phone'})`}
                />
              </div>
              {field('registration_number', 'Registration Number *', {
                required: true,
                placeholder: 'E.g. HR26AB1234',
              })}
              {field('make', 'Make *', { required: true })}
              {field('model', 'Model *', { required: true })}
              {field('variant', 'Variant')}
              <div>
                <label
                  htmlFor="vehicle-fuel-select"
                  className="block text-xs font-semibold text-gray-600 dark:text-gray-400"
                >
                  Fuel Type
                </label>
                <select
                  id="vehicle-fuel-select"
                  value={form.fuel_type}
                  onChange={set('fuel_type')}
                  className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 dark:border-gray-700 dark:bg-gray-800 text-sm focus-ring text-gray-950 dark:text-white"
                >
                  {['Petrol', 'Diesel', 'CNG', 'Electric'].map((fuel) => (
                    <option key={fuel}>{fuel}</option>
                  ))}
                </select>
              </div>
              {field('year', 'Manufacture Year', { type: 'number' })}
              {field('vin', 'VIN Number (17-digit)', { onChange: set('vin', true) })}
              {field('engine_number', 'Engine Number', { onChange: set('engine_number', true) })}
              {field('chassis_number', 'Chassis Number', { onChange: set('chassis_number', true) })}
              {field('odometer_reading', 'Odometer Reading (km)', { type: 'number' })}
            </div>
            <FormButtons
              onCancel={() => setEditing(null)}
              saving={save.isPending}
              saveLabel="Save Vehicle"
            />
          </form>
        </Modal>
      )}
    </div>
  );
}
