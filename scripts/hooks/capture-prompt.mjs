#!/usr/bin/env node
// UserPromptSubmit hook — deterministic raw capture of every prompt the owner
// sends (DEV-STRATEGY §5, layer 1). The model is NOT involved, so "every prompt
// saved" is guaranteed at 100%. Appends one JSON line per prompt to
// prompts-raw.jsonl (gitignored). Never blocks, never emits context.

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const data = JSON.parse(input || '{}');
  const entry = {
    at: new Date().toISOString(),
    session: data.session_id ?? null,
    cwd: data.cwd ?? null,
    prompt: data.prompt ?? '',
  };
  await appendFile(join(root, 'prompts-raw.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
} catch {
  // Never fail a prompt submission because of journaling.
}
process.exit(0);
