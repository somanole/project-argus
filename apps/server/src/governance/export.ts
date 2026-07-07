import type { GovernanceOverviewResponse, ScorePillar } from '@argus/shared';

/**
 * The S6 compliance export — a structured, readable governance report generated
 * from the SAME composed payload the screen renders, so it matches the dashboard
 * exactly (a report that diverges from the screen is worse than none). Plain
 * Markdown: hand it to a colleague and they understand the estate's state without
 * a tour. Uncertainty is preserved in prose (advisory owners, unavailable health,
 * confirmed-only reach) — never laundered into false precision.
 */

function scoreLine(score: number | null): string {
  return score == null ? 'not scorable (no measurable inputs)' : `${score} / 100`;
}

function pillarRow(p: ScorePillar): string {
  const s = p.score == null ? "couldn't score" : `${p.score}`;
  const weight = `${Math.round(p.weight * 100)}%`;
  return `| ${p.label} | ${weight} | ${s} | ${p.reason} |`;
}

function wfLine(w: { instanceLabel: string; name: string; criticality?: string | null }): string {
  const crit = w.criticality ? ` _(${w.criticality})_` : '';
  return `- ${w.name}${crit} — ${w.instanceLabel}`;
}

export function overviewToMarkdown(o: GovernanceOverviewResponse): string {
  const lines: string[] = [];
  const p = (s: string) => lines.push(s);

  p('# Argus — Governance report');
  p('');
  p(`_Generated ${o.generatedAt}. Composed from the live estate; numbers match the dashboard views._`);
  p('');

  // Score.
  p('## Governance score');
  p('');
  p(`**${scoreLine(o.score.score)}**`);
  p('');
  p('| Pillar | Weight | Score | What drove it |');
  p('| --- | --- | --- | --- |');
  for (const pillar of o.score.pillars) p(pillarRow(pillar));
  p('');
  const dropped = o.score.pillars.filter((x) => !x.scored);
  if (dropped.length > 0) {
    p(
      `> ${dropped.map((x) => x.label).join(', ')} could not be scored (no measurable inputs) and ` +
        'were dropped from the weighted average — never counted as a perfect score.',
    );
    p('');
  }

  // Ownership.
  p('## Unowned workflows');
  p('');
  const bc = o.unowned.byCriticality;
  p(
    `**${o.unowned.total}** workflows have no answerable owner ` +
      `(critical ${bc.critical}, high ${bc.high}, medium ${bc.medium}, low ${bc.low}, unlabeled ${bc.none}).`,
  );
  p('');
  for (const w of o.unowned.workflows) p(wfLine(w));
  if (o.unowned.workflows.length === 0) p('_None — every workflow has an answerable owner._');
  p('');

  // Accountability resilience.
  p('## Single-point-of-failure owners');
  p('');
  if (o.spofOwners.length === 0) p('_None._');
  for (const g of o.spofOwners) {
    const who = g.owner.name ?? g.owner.email ?? 'unknown';
    p(`- **${who}** owns ${g.workflows.length} critical workflows${g.crossInstance ? ' _(across instances)_' : ''}:`);
    for (const w of g.workflows) p(`  - ${w.name} — ${w.instanceLabel}`);
  }
  p('');

  p('## Critical workflows with no backup owner');
  p('');
  if (o.noBackupOwner.length === 0) p('_None._');
  for (const g of o.noBackupOwner) p(`- ${g.name} — ${g.instanceLabel} (owner: ${g.owner.name ?? g.owner.email ?? 'unknown'})`);
  p('');

  p('## Critical workflows in personal space');
  p('');
  if (o.personalSpaceCritical.length === 0) p('_None._');
  for (const g of o.personalSpaceCritical) p(`- ${g.name} — ${g.instanceLabel} (${g.person?.name ?? g.person?.email ?? 'unknown'})`);
  p('');

  // Reliability.
  p('## Failing/degraded workflows with a confirmed owner (actionable incidents)');
  p('');
  p(`**${o.failingWithOwner.count}** — a real person to page (inferred owners are advisory and excluded).`);
  p('');
  for (const w of o.failingWithOwner.workflows) {
    const rate = w.health ? ` — ${Math.round((w.health.failureRate ?? 0) * 100)}% failure` : '';
    p(`- ${w.name} — ${w.instanceLabel} (owner: ${ownerName(w)})${rate}`);
  }
  if (o.failingWithOwner.workflows.length === 0) p('_None._');
  p('');

  // Hygiene.
  p('## Hygiene');
  p('');
  p(`- Broken references: **${o.hygiene.brokenRefs.count}**`);
  p(`- Stale analysis: **${o.hygiene.staleEnrichment.count}**`);
  p(`- Active with no executions in window: **${o.hygiene.activeNoExecutions.count}**`);
  p('');

  // Exposure.
  p('## MCP exposure surface');
  p('');
  p(
    `**${o.exposure.mcpExposed}** MCP-exposed workflows; **${o.exposure.reachingSensitive}** reach a sensitive ` +
      `system (${o.exposure.reachingSensitiveUnowned} of them unowned). Confirmed reach only — inferred edges excluded.`,
  );
  p('');
  for (const s of o.exposure.surfaces.filter((x) => x.reachesSensitive)) {
    p(`- ${s.name} — ${s.instanceLabel}${s.owned ? '' : ' _(unowned)_'} → ${s.sensitiveSystems.join(', ')}`);
  }
  p('');

  // Freshness.
  p('## Freshness');
  p('');
  for (const w of o.health.windows) {
    p(`- ${w.instanceLabel}: ${w.available ? `health over ${w.windowHours}h` : '**health unavailable** (executions unreadable)'}`);
  }
  p('');

  return lines.join('\n');
}

function ownerName(w: { owner: { owner: { name: string | null; email: string | null } | null } | null }): string {
  const o = w.owner?.owner;
  return o?.name ?? o?.email ?? 'unknown';
}
