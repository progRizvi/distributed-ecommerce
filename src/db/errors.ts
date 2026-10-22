const UNIQUE_VIOLATION = '23505';

// Postgres error code can be on the error or (Drizzle wraps queries) on error.cause.
export function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);
  const cause = typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return code(error) === UNIQUE_VIOLATION || code(cause) === UNIQUE_VIOLATION;
}
