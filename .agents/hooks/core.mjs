import { checkDbDelete } from './db-guard.mjs';
// Agent-neutral policy. check() returns a reason string to block, or null to allow.
const BLOCKED_COMMANDS = [
  [/\bgit\s+(?:-[Cc]\s+\S+\s+)*(add|commit|push|stash|rebase|merge|cherry-pick|am|apply)\b/i, 'git add/commit/push are run by the user only'],
  [/\bgh\s+pr\s+(create|merge)\b/i, 'creating/merging PRs is done by the user only'],
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\*|\.\s*$)/i, 'recursive force delete of a broad path'],
  [/\bgit\s+push\b.*(--force|-f\b)/i, 'force push'],
  [/\bgit\s+push\b.*\b(main|master)\b/i, 'push to main/master'],
  [/--no-verify|--no-gpg-sign/i, 'skipping git hooks/signing'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard'],
  [/\b(drop\s+(database|table)|truncate\s+table)\b/i, 'destructive SQL'],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell)\b/i, 'piping download into a shell'],
  [/(cat|type|Get-Content|less|more)\s+[^|;&]*\.env\b/i, 'reading .env file'],
];

const PROTECTED_PATHS = [
  [/(^|[\/])\.env(\.[^\/]*)?$/i, '.env files'],
  [/\.(pem|key|p12|pfx)$/i, 'private key / certificate files'],
  [/(^|[\/])\.git[\/]/, '.git internals'],
  [/(^|[\/])id_(rsa|ed25519)/, 'ssh keys'],
];
const ALLOWED_PATHS = [/\.env\.example$/i];

export function check({ command, filePath }) {
  if (command) {
    const db = checkDbDelete(command);
    if (db) return db;
    for (const [re, why] of BLOCKED_COMMANDS) if (re.test(command)) return `Blocked: ${why}. Ask the user to run it themselves.`;
  }
  if (filePath && !ALLOWED_PATHS.some((re) => re.test(filePath))) {
    for (const [re, why] of PROTECTED_PATHS) if (re.test(filePath)) return `Blocked: access to ${why}.`;
  }
  return null;
}

// Normalize tool-call payloads from different agents into { command, filePath }.
export function normalize(payload) {
  const input = payload.tool_input ?? payload.input ?? payload.args ?? {};
  return {
    command: input.command ?? input.cmd ?? undefined,
    filePath: input.file_path ?? input.filePath ?? input.path ?? undefined,
  };
}
