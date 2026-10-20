// CLI adapter for agents that run hooks as commands and pass JSON on stdin (Claude Code, Codex).
// Exit code 2 + stderr = block and tell the agent why.
import { check, normalize } from './core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

let payload = {};
try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }

const reason = check(normalize(payload));
if (reason) {
  console.error(reason);
  process.exit(2);
}
