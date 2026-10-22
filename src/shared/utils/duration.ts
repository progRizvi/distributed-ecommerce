const SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

// "15m" -> 900. Same format as JWT_EXPIRES_IN.
export function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`Invalid duration: ${value}`);
  return Number(match[1]) * SECONDS[match[2] as keyof typeof SECONDS];
}
