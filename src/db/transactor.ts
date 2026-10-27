import type { Database } from './client.js';

// The connection a repository method runs on while a transaction is open.
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// Runs several writes as one unit: all of them are saved, or none (when the callback throws).
// Services use this interface, so they never see Drizzle and tests can pass a fake.
export interface Transactor {
  run<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
}

export class DrizzleTransactor implements Transactor {
  constructor(private readonly db: Database) {}

  run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }
}
