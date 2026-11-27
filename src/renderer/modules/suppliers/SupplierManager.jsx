import React from 'react';
import { Truck } from 'lucide-react';
import PartyScreen from '../../shared/components/PartyScreen.jsx';

const config = {
  resource: 'suppliers',
  permission: 'suppliers.write',
  icon: Truck,
  words: {
    one: 'supplier',
    title: 'Supplier',
    heading: 'Suppliers',
    description: 'Shops and companies you buy parts from.',
    add: 'Add Supplier',
    nameLabel: 'Supplier name',
    save: 'Save Supplier',
    created: 'Supplier registered.',
    updated: 'Supplier updated.',
    deleted: 'Supplier deleted.',
  },
};

export default function SupplierManager() {
  return <PartyScreen config={config} />;
}
