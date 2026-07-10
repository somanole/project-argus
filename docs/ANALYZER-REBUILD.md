# Rebuilding the analyzer for a new n8n version

The Argus analyzer recognizes n8n node/credential types from a **vendored manifest**
(`apps/server/src/analyzer/manifest.data.ts`) generated at build time from the n8n
**source tree**, pinned to a specific n8n version (currently **2.29.0** — see
[`CLAUDE.md`](../CLAUDE.md) → version pins). Runtime never touches the n8n source; it reads
the vendored manifest only.

When you **upgrade** a connected n8n instance past the pinned version, the manifest can go
stale: node types introduced after the pin become unrecognized, so their workflows are
**under-analyzed** — they show as *"couldn't analyze"*, never mislabeled (rule 5). Argus
flags this on the **Connections** screen as *"Coverage may have dropped"* when it observes
unrecognized **core** node types (`n8n-nodes-base.*` / `@n8n/n8n-nodes-langchain.*`) on an
instance. (Unrecognized **community/custom** nodes are a different case — see below.)

## Why this is a build/ops step, not one click in the app

A deployed Argus is Public-API-only: it holds a **read-only API key** for each instance and
no browser session. The rule-1 probe (`pnpm probe:freshness`, captured in
[`contracts/n8n-21-version-unreachable.json`](../contracts/n8n-21-version-unreachable.json)
and [`contracts/n8n-22-types-nodes-auth.json`](../contracts/n8n-22-types-nodes-auth.json))
confirmed that neither the running n8n **version** nor its **node-type catalog**
(`/types/nodes.json`) is reachable with an API key — both require a session cookie. So Argus
cannot refresh the manifest from a live instance at runtime, and a deployed image has no n8n
source tree to regenerate from. Regeneration is therefore a **build/ops** action (see
[Decision #32](DECISIONS.md)).

## Steps

1. **Update the n8n source pin.** Point the sibling `../n8n` checkout (Argus's contract oracle
   and manifest source) at the n8n version your instances now run, and update the version pins
   in [`CLAUDE.md`](../CLAUDE.md) and `scripts/gen-manifest.mjs` (`N8N_VERSION`). Build n8n if
   its `packages/*/dist` type artifacts aren't present.
2. **Regenerate the manifest.** From the repo root:
   ```bash
   pnpm gen:manifest
   ```
   This rewrites `apps/server/src/analyzer/manifest.data.ts` from the upgraded source
   (`packages/nodes-base` + `@n8n/n8n-nodes-langchain` type JSON). Commit the regenerated file.
3. **Re-verify against the live instances (rule 1).**
   ```bash
   pnpm probe:freshness   # re-confirm the version/metadata reachability assumptions
   pnpm verify            # coverage + drift rows go green; core-drift returns to 0
   ```
4. **Redeploy Argus** with the new image. Within one poll cycle each connection's drift notice
   clears (the newly-pinned manifest now recognizes the upgraded instance's core nodes).

## Community / custom nodes

Unrecognized types outside the core namespaces are **third-party** community or custom nodes.
The source-vendored manifest **can never know them** — regenerating from n8n source will not
add them. Argus labels these *"community/custom — a rebuild won't add them"* and does **not**
prompt a regenerate. They remain honestly *"couldn't analyze"* until first-class
community-node support is added (out of scope for S6.1).
