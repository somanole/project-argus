#!/usr/bin/env node
// SessionStart hook — two jobs (DEV-STRATEGY §5, layers 2 & 3):
//   1. Write this session's baseline (git HEAD + PROMPTS.md hash) so the Stop
//      hook can tell whether code changed vs whether PROMPTS.md got an entry.
//   2. Backfill guard: if any PAST session left prompts in prompts-raw.jsonl but
//      no PROMPTS.md entry (detected via the `<!-- session: X -->` markers),
//      inject context telling Claude to backfill from the transcript first.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let input = '';
for await (const chunk of process.stdin) input += chunk;
let data = {};
try { data = JSON.parse(input || '{}'); } catch { /* fall through */ }
const sid = data.session_id ?? 'unknown';

const gitSafe = (args) => {
  try { return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
};
const promptsHash = () => {
  try { return createHash('sha1').update(readFileSync(join(root, 'PROMPTS.md'))).digest('hex'); }
  catch { return ''; }
};

// 1. Baseline marker for the Stop hook.
try {
  const dir = join(root, '.claude', '.session-state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sid}.json`),
    JSON.stringify({ session: sid, at: new Date().toISOString(), head: gitSafe('rev-parse HEAD'), promptsHash: promptsHash() }),
    'utf8',
  );
} catch { /* non-fatal */ }

// 2. Backfill detection.
let missing = [];
try {
  const rawPath = join(root, 'prompts-raw.jsonl');
  const raw = existsSync(rawPath) ? readFileSync(rawPath, 'utf8') : '';
  const sessions = new Set();
  for (const line of raw.split('\n').filter(Boolean)) {
    try { const e = JSON.parse(line); if (e.session) sessions.add(e.session); } catch { /* skip */ }
  }
  sessions.delete(sid);
  const journal = existsSync(join(root, 'PROMPTS.md')) ? readFileSync(join(root, 'PROMPTS.md'), 'utf8') : '';
  missing = [...sessions].filter((s) => !journal.includes(s));
} catch { /* non-fatal */ }

if (missing.length) {
  const ctx =
    `⚠️ PROMPTS.md backfill required (standing rule 8): ${missing.length} earlier session(s) ` +
    `submitted prompts (recorded in prompts-raw.jsonl) but have no journal entry: ${missing.join(', ')}. ` +
    'Reconstruct their PROMPTS.md entries from the session transcripts BEFORE starting other work.';
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
}
process.exit(0);
