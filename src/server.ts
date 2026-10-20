import { buildApp } from './app.js';
import { env } from './bootstrap/env.js';
import { registerShutdown } from './bootstrap/shutdown.js';

const app = await buildApp();
registerShutdown(app);

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
