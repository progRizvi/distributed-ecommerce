import type { FastifyInstance } from 'fastify';
import { authRoutes } from '../modules/auth/index.js';
import { usersRoutes } from '../modules/users/index.js';
import { productsRoutes } from '../modules/products/index.js';
import { categoriesRoutes } from '../modules/categories/index.js';
import { cartRoutes } from '../modules/cart/index.js';
import { ordersRoutes } from '../modules/orders/index.js';
import { paymentsRoutes } from '../modules/payments/index.js';
import { inventoryRoutes } from '../modules/inventory/index.js';
import { shippingRoutes } from '../modules/shipping/index.js';

export async function setupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', { schema: { tags: ['system'], summary: 'Liveness check' } }, async () => ({ status: 'ok', uptime: process.uptime() }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(usersRoutes, { prefix: '/api/users' });
  await app.register(productsRoutes, { prefix: '/api/products' });
  await app.register(categoriesRoutes, { prefix: '/api/categories' });
  await app.register(cartRoutes, { prefix: '/api/cart' });
  await app.register(ordersRoutes, { prefix: '/api/orders' });
  await app.register(paymentsRoutes, { prefix: '/api/payments' });
  await app.register(inventoryRoutes, { prefix: '/api/inventory' });
  await app.register(shippingRoutes, { prefix: '/api/shipping' });
}
