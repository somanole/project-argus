#!/usr/bin/env node
// Stop hook — blocks ending a turn where code changed this session but
// PROMPTS.md got no new entry (DEV-STRATEGY §5, layer 2; standing rule 8).
// Rule 8 defines entry QUALITY; this hook guarantees entry EXISTENCE.
//
// Loop guard: if `stop_hook_active` is true, this stop is already the result of
// a prior block — exit 0 so we never wedge the session.
// Baseline: SessionStart writes .claude/.session-state/<id>.json (git HEAD +
// PROMPTS.md hash). No marker (e.g. the very first session) → lenient (exit 0):
// a false block is worse than a missed entry, and other layers back it up.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let input = '';
for await (const chunk of process.stdin) input += chunk;
let data = {};
try { data = JSON.parse(input || '{}'); } catch { /* fall through */ }

const done = () => process.exit(0);
if (data.stop_hook_active) done(); // loop guard

const git = (args) =>
  execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

try { git('rev-parse --is-inside-work-tree'); } catch { done(); }

const markerPath = join(root, '.claude', '.session-state', `${data.session_id}.json`);
if (!existsSync(markerPath)) done();
let marker;
try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { done(); }

const isJournalFile = (f) =>
  f === 'PROMPTS.md' || f === 'prompts-raw.jsonl' || f.startsWith('.claude/.session-state/');

const changed = new Set();
try {
  const range = marker.head ? `diff --name-only ${marker.head} HEAD` : 'ls-files';
  for (const f of git(range).split('\n').filter(Boolean)) changed.add(f);
} catch { /* ignore */ }
try {
  for (const line of git('status --porcelain').split('\n').filter(Boolean)) {
    changed.add(line.slice(3).replace(/^.* -> /, '')); // handle renames "old -> new"
  }
} catch { /* ignore */ }

const codeChanged = [...changed].some((f) => !isJournalFile(f));

let promptsHash = '';
try { promptsHash = createHash('sha1').update(readFileSync(join(root, 'PROMPTS.md'))).digest('hex'); } catch { /* none */ }
const promptsChanged =
  changed.has('PROMPTS.md') || (!!marker.promptsHash && !!promptsHash && promptsHash !== marker.promptsHash);

if (codeChanged && !promptsChanged) {
  const reason =
    'Code changed this session but PROMPTS.md has no new entry. Append your rule-8 ' +
    'journal entry using the template at the top of PROMPTS.md (include the ' +
    `\`<!-- session: ${data.session_id ?? ''} -->\` marker), then stop.`;
  console.log(JSON.stringify({ decision: 'block', reason }));
}
process.exit(0);
