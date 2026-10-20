import { seedCarts } from './seeders/05-carts.seeder.js';
import { seedCategories } from './seeders/02-categories.seeder.js';
import { seedInventory } from './seeders/04-inventory.seeder.js';
import { seedOrders } from './seeders/06-orders.seeder.js';
import { seedPayments } from './seeders/07-payments.seeder.js';
import { seedProducts } from './seeders/03-products.seeder.js';
import { seedSearchIndex } from './seeders/09-search-index.seeder.js';
import { seedShipping } from './seeders/08-shipping.seeder.js';
import { seedUsers } from './seeders/01-users.seeder.js';

export interface SeedOptions {
  count?: number | undefined;
}

// Order matters: later seeders need rows from earlier ones.
const seeders = [
  ['users', seedUsers],
  ['categories', seedCategories],
  ['products', seedProducts],
  ['inventory', seedInventory],
  ['carts', seedCarts],
  ['orders', seedOrders],
  ['payments', seedPayments],
  ['shipping', seedShipping],
  ['search-index', seedSearchIndex],
] as const;

export async function runSeeders(options: SeedOptions & { only?: string | undefined }): Promise<void> {
  for (const [name, seed] of seeders) {
    if (options.only && options.only !== name) continue;
    console.log(`seeding ${name}...`);
    await seed(options);
  }
  console.log('seed done');
}
