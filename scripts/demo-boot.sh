#!/bin/bash
# Argus public demo — launchd boot script (com.argus.demo).
#
# Brings the PRIVATE n8n estate up, re-applies its in-memory license flags
# (lost on every n8n restart — standing CLAUDE.md note), then becomes the
# long-lived single-origin Argus server. launchd KeepAlive reruns this whole
# script if the server exits, so n8n + license flags are always re-ensured.
#
# The server is wrapped in `caffeinate -s` so the Mac mini won't system-sleep
# while the demo is live (no sudo needed; desktop is always on AC power).
#
# This agent manages ONLY the local server + n8n. Public exposure is a separate,
# persistent Tailscale Funnel (survives reboot on its own via tailscaled).
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd /Users/stelo/n8n-workspace/project-argus || exit 1

echo "[demo-boot] $(date) ensuring private n8n estate is up"
pnpm n8n:up      || echo "[demo-boot] n8n:up returned non-zero (continuing)"
echo "[demo-boot] $(date) re-applying n8n license flags (in-memory)"
pnpm seed:unlock || echo "[demo-boot] seed:unlock returned non-zero (continuing)"

echo "[demo-boot] $(date) starting Argus single-origin server on :3080 (per .env)"
exec caffeinate -s node --env-file=.env apps/server/dist/index.js
