const roles = [
  ['Admin', 'Full system access.'],
  ['Manager', 'Workshop operations and reporting access.'],
  ['Mechanic', 'Job card and service workflow access.'],
  ['Billing Staff', 'Invoice, customer, and payment workflow access.'],
];

const permissions = [
  ['users.manage', 'Create, update, and disable users.'],
  ['customers.read', 'View customers.'],
  ['customers.write', 'Create and update customers.'],
  ['vehicles.read', 'View vehicles.'],
  ['vehicles.write', 'Create and update vehicles.'],
  ['suppliers.read', 'View suppliers.'],
  ['suppliers.write', 'Create and update suppliers.'],
  ['warehouses.read', 'View warehouses.'],
  ['warehouses.write', 'Create and update warehouses.'],
  ['inventory.read', 'View inventory.'],
  ['inventory.write', 'Create and update inventory items.'],
  ['inventory.adjust', 'Adjust inventory stock.'],
  ['purchases.read', 'View purchases.'],
  ['purchases.write', 'Create and update purchases.'],
  ['job_cards.read', 'View job cards.'],
  ['job_cards.write', 'Create and update job cards.'],
  ['job_cards.assign', 'Assign mechanics to job cards.'],
  ['invoices.read', 'View invoices.'],
  ['invoices.write', 'Create and update invoices.'],
  ['invoices.finalize', 'Finalize invoices.'],
  ['invoices.cancel', 'Cancel invoices.'],
  ['expenses.read', 'View expenses.'],
  ['expenses.write', 'Create and update expenses.'],
  ['gst.read', 'View GST reports.'],
  ['profit.read', 'View profit records.'],
  ['tally.export', 'Export Tally data.'],
  ['dashboard.read', 'View dashboard analytics.'],
  ['audit.read', 'View audit logs.'],
  ['backups.read', 'View database backups and logs.'],
  ['backups.write', 'Create manual database backups.'],
  [
    'accounting.read',
    'View general ledgers, voucher entries, trial balance, P&L, and balance sheets.',
  ],
  [
    'accounting.write',
    'Post manual vouchers (Contra, Journal, Payments, Receipts) and adjust/cancel accounting logs.',
  ],
];

const rolePermissionKeys = {
  Admin: permissions.map(([key]) => key),
  Manager: permissions
    .map(([key]) => key)
    .filter((key) => !['users.manage', 'backups.read', 'backups.write'].includes(key)),
  Mechanic: [
    'customers.read',
    'vehicles.read',
    'inventory.read',
    'job_cards.read',
    'job_cards.write',
    'dashboard.read',
  ],
  'Billing Staff': [
    'customers.read',
    'customers.write',
    'vehicles.read',
    'vehicles.write',
    'job_cards.read',
    'invoices.read',
    'invoices.write',
    'invoices.finalize',
    'gst.read',
    'dashboard.read',
  ],
};

export async function run(db) {
  const insertRole = db.prepare(`
    INSERT INTO roles (name, description)
    VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP
  `);

  const insertPermission = db.prepare(`
    INSERT INTO permissions (key, description)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET description = excluded.description
  `);

  const linkPermission = db.prepare(`
    INSERT OR IGNORE INTO role_permissions (role_id, permission_id)
    SELECT roles.id, permissions.id FROM roles, permissions
    WHERE roles.name = ? AND permissions.key = ?
  `);

  db.transaction(() => {
    for (const role of roles) insertRole.run(...role);
    for (const permission of permissions) insertPermission.run(...permission);
    for (const [roleName, permissionKeys] of Object.entries(rolePermissionKeys))
      for (const permissionKey of permissionKeys) linkPermission.run(roleName, permissionKey);
  })();
}
