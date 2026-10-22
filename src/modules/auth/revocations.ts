// Access tokens are JWTs: the server does not look them up, so logout alone cannot stop them.
// This keeps a short-lived "revoked" mark in Redis. Entries expire when the access token would have
// expired anyway, so Redis only ever holds a few minutes of data.
export interface TokenRevocations {
  /** This login session (one device) is over. Its access tokens stop working. */
  revokeSession(sid: string, ttlSeconds: number): Promise<void>;
  /** Every access token this user got before now stops working (logout from all devices). */
  revokeUser(userId: string, ttlSeconds: number): Promise<void>;
  isRevoked(token: { sub: string; sid: string; iat: number }): Promise<boolean>;
}

// The parts of ioredis we use.
export interface RevocationStore {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

const sessionKey = (sid: string) => `auth:revoked-sid:${sid}`;
const userKey = (userId: string) => `auth:revoked-after:${userId}`;

export class RedisTokenRevocations implements TokenRevocations {
  constructor(
    private readonly store: RevocationStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async revokeSession(sid: string, ttlSeconds: number): Promise<void> {
    await this.store.set(sessionKey(sid), '1', 'EX', Math.max(1, Math.ceil(ttlSeconds)));
  }

  async revokeUser(userId: string, ttlSeconds: number): Promise<void> {
    const after = Math.floor(this.now() / 1000);
    await this.store.set(userKey(userId), String(after), 'EX', Math.max(1, Math.ceil(ttlSeconds)));
  }

  // One Redis call (MGET) checks both marks.
  async isRevoked(token: { sub: string; sid: string; iat: number }): Promise<boolean> {
    const [sessionMark, revokedAfter] = await this.store.mget(sessionKey(token.sid), userKey(token.sub));
    if (sessionMark !== null) return true;
    // iat is in whole seconds. "<" (not "<=") so a login right after logout-all still works.
    // Cost: a token issued in the same second as logout-all survives (under 1 second window).
    return revokedAfter !== null && token.iat < Number(revokedAfter);
  }
}
