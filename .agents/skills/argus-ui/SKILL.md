---
name: argus-ui
description: Build Argus UI that looks genuinely like n8n. Use whenever adding or changing anything in apps/web — a view, component, form, table, badge, or style. Enforces the vendored-token + both-themes contract (standing rule 10) and the app's reusable patterns.
---

# argus-ui — how Argus's web UI is built

Argus's UI must look like a native part of n8n and render correctly in **both**
light and dark. This is a hard rule (CLAUDE.md rule 10), not a preference.

## The three non-negotiables

1. **Vendored tokens only.** Every color, space, radius, font-size, weight, and
   shadow is a `var(--…)` from the vendored n8n tokens. **Never** a hard-coded
   hex, px color, or font name. Tokens live in
   `apps/web/src/styles/n8n-tokens/` (see its `VENDORED.md`). `pnpm verify` greps
   the built CSS for stray hex and fails on any.
2. **Both themes, always.** Theming is n8n's mechanism: `body[data-theme='dark']`
   + `prefers-color-scheme`. Because the semantic tokens (`--background--surface`,
   `--color--text--shade-1`, `--border-color`, the `--*--success/warning/danger`
   families) carry light AND dark values, **if you only use tokens you get dark
   mode for free** — don't write theme-specific CSS. Verify visually in both.
3. **Reuse the primitives.** Global classes live in `apps/web/src/styles/app.scss`:
   `.btn` (+`--primary/--secondary/--danger/--ghost/--sm/--block`), `.input`,
   `.field` (+`.hint`), `.card`, `.badge` (+`--ok/--warn/--danger/--muted`),
   `.dot` (+`--ok/--warn/--danger/--muted`), `.muted`, `.mono`. Compose these;
   add only *scoped* layout CSS per component.

## Patterns already in the codebase (copy these)

- **State machine stores** (`src/stores/*.ts`): `'idle' | 'loading' | 'ok' |
  'error'`; render a branch per state; error holds a plain-English reason. Never
  invent data you don't have — show "—" or "couldn't …" (rule 5).
- **API access** (`src/lib/api.ts`): `api(path, opts, schema)` — validates the
  response against a `@argus/shared` zod schema and throws `ApiError` (carrying
  the server's `error` string) on failure.
- **Shared contract**: request/response types come from `@argus/shared`; never
  hand-redeclare a server shape in the web app.
- **Routing/auth**: `src/router.ts` guards everything but `/login`; the shell in
  `App.vue` renders only when signed in.
- **Reusable view atoms**: `components/StateBadge.vue`, `components/HealthBadge.vue`,
  `lib/instanceColor.ts` (stable per-instance accent from the token palette),
  `lib/time.ts` (`relativeTime`).

## Token cheat-sheet (the ones you'll reach for)

| Need | Token |
|---|---|
| Page background | `--background--surface` |
| Card / subtle background | `--background--subtle` |
| Hover background | `--background--hover` |
| Primary text | `--color--text--shade-1` |
| Brand fill (buttons, active) | `--background--brand` (+ `--hover`, `--disabled`) |
| Borders | `--border-color` (+ `--subtle`, `--strong`) |
| Success / warning / danger | `--background--success` · `--text-color--success` (+ `warning`, `danger`) |
| Spacing | `--spacing--4xs … --spacing--3xl` |
| Radius | `--radius--2xs … --radius--full` |
| Font size / weight | `--font-size--3xs … --xl` · `--font-weight--regular/medium/bold` |
| Mono | `--font-family--monospace` |

## Before you finish

Run the app (`preview_*` / `pnpm dev`) and confirm the change renders in **light
AND dark** (toggle in the top bar). Then `pnpm typecheck && pnpm lint`. A UI
change isn't done until it's correct in both themes.
