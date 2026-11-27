import { createInventoryService } from '../../modules/inventory/inventory.service.js';

export async function run(db) {
  // Tests start from an empty catalogue.
  if (process.env.NODE_ENV === 'test' || process.execArgv.includes('--test')) {
    console.log('Skipping starter inventory seeding in test environment.');
    return;
  }

  console.log('Automatically populating starter inventory catalog during setup...');
  const inventoryService = createInventoryService(db);
  const result = inventoryService.seedStarter();
  console.log(`Starter inventory catalog loaded: seeded ${result.itemsSeeded} items.`);
}
