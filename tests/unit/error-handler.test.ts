import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { setupErrorHandler } from '../../src/bootstrap/error-handler.js';
import { NotFoundError } from '../../src/shared/errors/app-error.js';

function buildApp() {
  const app = Fastify();
  setupErrorHandler(app);
  app.get('/app-error', async () => {
    throw new NotFoundError('Product not found');
  });
  app.get('/crash', async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
  });
  app.get('/client-error', async () => {
    throw Object.assign(new Error('internal detail: token signature mismatch for user 42'), { statusCode: 401 });
  });
  app.post('/validate', { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, async () => ({}));
  return app;
}

describe('error handler', () => {
  it('shows AppError message to the client', async () => {
    const res = await buildApp().inject('/app-error');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'NOT_FOUND', message: 'Product not found' });
  });

  it('hides the message of unexpected 500 errors', async () => {
    const res = await buildApp().inject('/crash');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(res.body).not.toContain('hunter2');
    expect(res.json().message).toBe('Something went wrong');
  });

  it('hides the internal message of other 4xx errors', async () => {
    const res = await buildApp().inject('/client-error');
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('signature');
    expect(res.json()).toEqual({ error: 'UNAUTHORIZED', message: 'Unauthorized' });
  });

  it('returns field details for validation errors', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/validate', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
    expect(res.json().details).toHaveLength(1);
  });

  it('returns a clean 404 for unknown routes', async () => {
    const res = await buildApp().inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
  });
});
