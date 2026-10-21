import { env } from './env.js';

// Passed to Fastify({ trustProxy }). Without it request.ip is always Nginx's IP,
// so rate limit would count every user as one client.
export const trustProxy: string | false = env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY;
