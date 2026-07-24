---
name: argus-ui
description: Build Argus UI consistently. Use whenever adding or changing anything in apps/web — a view, component, form, table, badge, or style. Enforces the design-token + both-themes + both-viewports (responsive) contract (standing rule 10) and the app's reusable patterns.
---

# argus-ui — how Argus's web UI is built

Argus's UI must look like a native part of n8n, render correctly in **both** light
and dark, and stay usable from **mobile (375px) through desktop**. These are hard
rules (CLAUDE.md rule 10), not preferences.

## The four non-negotiables

1. **Design tokens only.** Every color, space, radius, font-size, weight, and
   shadow is a `var(--…)` from the Argus design tokens. **Never** a hard-coded
   hex, px color, or font name. Tokens live in
   `apps/web/src/styles/theme/tokens.scss` (original work — nothing vendored).
   `pnpm verify` greps the built CSS for stray hex and fails on any.
2. **Both themes, always.** Theming is `body[data-theme='dark']`
   + `prefers-color-scheme`. Because the semantic tokens (`--background--surface`,
   `--color--text--shade-1`, `--border-color`, the `--*--success/warning/danger`
   families) carry light AND dark values, **if you only use tokens you get dark
   mode for free** — don't write theme-specific CSS. Verify visually in both.
3. **Reuse the primitives.** Global classes live in `apps/web/src/styles/app.scss`:
   `.btn` (+`--primary/--secondary/--danger/--ghost/--sm/--block`), `.input`,
   `.field` (+`.hint`), `.card`, `.badge` (+`--ok/--warn/--danger/--muted`),
   `.dot` (+`--ok/--warn/--danger/--muted`), `.muted`, `.mono`. Compose these;
   add only *scoped* layout CSS per component.
4. **Responsive from the first line, not retrofitted.** Desktop is the primary
   design target, but every view must stay usable and unbroken from **375px** up —
   **no horizontal page scroll, no cut-off fields**. Build it responsive as you go;
   never ship a fixed-width layout meaning to "do mobile later." `pnpm verify`
   renders each hero view at 375px and fails on horizontal overflow.

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

## Responsive patterns (how to hit non-negotiable 4)

- **Fluid over fixed.** Prefer `%`, `fr`, `minmax()`, `flex`, `clamp()` and the
  spacing tokens over fixed `px` widths. A layout that never asserts a width it
  can't have is responsive almost by default.
- **Wide content reflows or scrolls — never clips.** The catalog table is the
  classic trap. Either (a) collapse rows to stacked cards below a breakpoint, or
  (b) wrap the table in an `overflow-x: auto` container so it scrolls *within its
  panel* — never let the page itself scroll sideways or fields get cut off.
- **The shell adapts.** Multi-column shells (list + detail drawer, filters + grid)
  become single-column / off-canvas on narrow widths; the detail drawer goes
  full-width. Filters collapse behind a control rather than overflowing the bar.
- **Breakpoints:** a small local set is fine — keep them few and consistent
  across views.
- **Touch targets** stay comfortably tappable (don't shrink controls below the
  primitive sizes on mobile).

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
AND dark** (toggle in the top bar) **and at 375px AND desktop** (`preview_resize`
mobile/desktop) — no horizontal overflow, no cut-off content. Then `pnpm typecheck
&& pnpm lint`. A UI change isn't done until it's correct in **both themes and both
widths**.
