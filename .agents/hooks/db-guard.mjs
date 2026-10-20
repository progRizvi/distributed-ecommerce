// Blocks commands that delete database data. The user lifts the block by starting
// the agent with ALLOW_DB_DELETE=1 in its environment (an agent cannot set that for its own hook).
const DB_DELETE = [
  [/\bdelete\s+from\b/i, 'SQL DELETE'],
  [/\b(drop|truncate)\s+(database|schema|table|collection|index)\b/i, 'SQL DROP/TRUNCATE'],
  [/\.(deleteMany|deleteOne|drop|dropDatabase|dropCollection|remove|findOneAndDelete|bulkWrite)\s*\(/i, 'MongoDB delete/drop'],
  [/\b(flushall|flushdb)\b/i, 'Redis flush'],
  [/\bredis-cli\b.*\b(del|unlink)\b/i, 'Redis key delete'],
  [/\bprisma\s+migrate\s+reset\b|--force-reset|\bprisma\s+db\s+(push\s+--accept-data-loss|execute)\b/i, 'Prisma reset / data loss'],
  [/\b(db:drop|db:reset|db:migrate:undo:all|migrate:fresh|migrate:reset|migrate:rollback|schema:drop)\b/i, 'ORM drop/reset'],
  [/\b(dropdb|mongosh?|psql|mysql|sqlite3)\b.*\b(delete|drop|truncate)\b/i, 'DB CLI destructive statement'],
  [/\bdocker\s+(compose\s+down\s+.*(-v|--volumes)|volume\s+(rm|prune))\b/i, 'removing Docker volumes (database data)'],
  [/\brm\s+.*\.(sqlite3?|db)\b/i, 'deleting database file'],
];

export function checkDbDelete(command) {
  if (!command || process.env.ALLOW_DB_DELETE === '1') return null;
  for (const [re, why] of DB_DELETE) {
    if (re.test(command)) return `Blocked: ${why}. Database data is never deleted unless the user explicitly says so.`;
  }
  return null;
}
