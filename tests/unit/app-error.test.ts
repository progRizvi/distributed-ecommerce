import { describe, expect, it } from 'vitest';
import { NotFoundError } from '../../src/shared/errors/app-error.js';

describe('AppError', () => {
  it('NotFoundError has status 404', () => {
    const err = new NotFoundError('missing');
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });
});
