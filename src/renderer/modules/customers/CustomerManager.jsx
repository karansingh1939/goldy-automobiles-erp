import React from 'react';
import { UserPlus } from 'lucide-react';
import PartyScreen from '../../shared/components/PartyScreen.jsx';

const config = {
  resource: 'customers',
  permission: 'customers.write',
  icon: UserPlus,
  words: {
    one: 'customer',
    title: 'Customer',
    heading: 'Customers',
    description:
      'Everyone who brings a car, with phone, GSTIN and how much credit (udhaar) you allow.',
    add: 'Add Customer',
    nameLabel: 'Customer name',
    save: 'Save Profile',
    created: 'Customer profile registered.',
    updated: 'Customer profile updated.',
    deleted: 'Customer profile deleted.',
  },
  extraField: { key: 'credit_limit', label: 'Credit Limit (₹)' },
  extraColumn: {
    accessorKey: 'credit_limit',
    header: 'Credit Limit',
    cell: (info) => (info.getValue() ? `₹${info.getValue().toLocaleString('en-IN')}` : 'No Limit'),
  },
};

export default function CustomerManager() {
  return <PartyScreen config={config} />;
}
