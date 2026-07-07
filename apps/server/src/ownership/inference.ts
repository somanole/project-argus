import type { N8nProject, N8nProjectMember, N8nUser } from '@argus/shared';
import { HttpError, reason } from '../n8n/client.js';
import type { InferredOwnerRow } from './repo.js';

/**
 * Ownership INFERENCE (S4) — the advisory owner, from n8n project membership/roles ONLY
 * (spec .agents/specs/ownership.md). Runs on the reconciliation tick after the workflow
 * cache refresh; results are cached in the disposable workflow_inferred_owner table and
 * NEVER audited. Assignment always overrides inference (read-path COALESCE).
 *
 * Honest degradation (rule 5): when membership can't be read (unlicensed / missing
 * `user:list` / fetch error), the row is `source:'unavailable'` with a plain reason and
 * NO owner — never a fabricated name.
 */

/** The client surface inference needs (a subset of the n8n client; injectable for tests). */
export interface InferenceReader {
  listProjectMembers(projectId: string): Promise<N8nProjectMember[]>;
  listUsers(): Promise<N8nUser[]>;
}

/** One workflow's identity for inference: its id + the project it's owned by. */
export interface InferenceWorkflow {
  id: string;
  projectId: string | null;
}

const ROLE_RANK: Record<string, number> = {
  'project:admin': 3,
  'project:editor': 2,
  'project:viewer': 1,
};

const fullName = (u: { firstName?: string | null | undefined; lastName?: string | null | undefined }): string | null =>
  [u.firstName, u.lastName].filter(Boolean).join(' ') || null;

/** The most-privileged member (admin > editor > viewer); ties broken by lowest email (stable). */
function mostPrivileged(members: N8nProjectMember[]): N8nProjectMember | null {
  let best: N8nProjectMember | null = null;
  let bestRank = -1;
  for (const m of members) {
    const rank = m.role ? ROLE_RANK[m.role] ?? 0 : 0;
    if (rank > bestRank || (rank === bestRank && best != null && m.email < best.email)) {
      best = m;
      bestRank = rank;
    }
  }
  return best;
}

/** Resolve a personal project's owner: creatorId → user, else parse "First Last <email>". */
function personalOwner(project: N8nProject, usersById: Map<string, N8nUser>): { email: string | null; name: string | null } | null {
  if (project.creatorId) {
    const u = usersById.get(project.creatorId);
    if (u) return { email: u.email, name: fullName(u) };
  }
  const m = project.name.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]?.trim() || null, email: m[2]?.trim() || null };
  return null;
}

function memberErrorReason(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return `couldn't infer — the API key may lack \`user:list\`, or the instance isn't licensed for project roles (HTTP ${err.status})`;
  }
  return `couldn't infer — ${reason(err)}`;
}

/**
 * Compute the inferred owner for every workflow in one instance. Members are fetched
 * at most once per distinct team project; a per-project fetch failure degrades only
 * that project's workflows (a 401/403 degrades them all, honestly). Personal-space
 * inference uses only the projects list (+ best-effort users list), so it still works
 * when the members endpoint is forbidden.
 */
export async function inferOwnership(
  reader: InferenceReader,
  projects: N8nProject[],
  workflows: InferenceWorkflow[],
): Promise<InferredOwnerRow[]> {
  const projectById = new Map(projects.map((p) => [p.id, p]));

  // Best-effort user roster (for personal creatorId resolution + name fallback).
  let usersById = new Map<string, N8nUser>();
  try {
    usersById = new Map((await reader.listUsers()).map((u) => [u.id, u]));
  } catch {
    // Personal inference falls back to parsing the project name; team inference is
    // unaffected (it reads members, not the global user list).
  }

  // Fetch members once per DISTINCT team project that owns at least one workflow.
  const teamProjectIds = new Set(
    workflows
      .map((w) => w.projectId)
      .filter((id): id is string => id != null && projectById.get(id)?.type === 'team'),
  );
  const membersByProject = new Map<string, N8nProjectMember[] | { error: string }>();
  for (const pid of teamProjectIds) {
    try {
      membersByProject.set(pid, await reader.listProjectMembers(pid));
    } catch (err) {
      membersByProject.set(pid, { error: memberErrorReason(err) });
    }
  }

  return workflows.map((w) => {
    const project = w.projectId ? projectById.get(w.projectId) : undefined;
    if (!project) {
      return {
        workflowId: w.id,
        ownerEmail: null,
        ownerName: null,
        source: 'unavailable',
        memberRole: null,
        reason: "couldn't infer — the owning project isn't visible",
      };
    }

    if (project.type === 'personal') {
      const person = personalOwner(project, usersById);
      return {
        workflowId: w.id,
        ownerEmail: person?.email ?? null,
        ownerName: person?.name ?? null,
        // Keep source 'personal-project' even when the person is unresolved, so the
        // personal-space-critical gap still detects the location honestly.
        source: 'personal-project',
        memberRole: null,
        reason: person ? null : "couldn't infer — the personal-space owner isn't resolvable",
      };
    }

    // Team project.
    const members = membersByProject.get(project.id);
    if (!members || 'error' in members) {
      return {
        workflowId: w.id,
        ownerEmail: null,
        ownerName: null,
        source: 'unavailable',
        memberRole: null,
        reason: members && 'error' in members ? members.error : "couldn't infer — the project's members are unavailable",
      };
    }
    const top = mostPrivileged(members);
    if (!top) {
      return {
        workflowId: w.id,
        ownerEmail: null,
        ownerName: null,
        source: 'unavailable',
        memberRole: null,
        reason: "couldn't infer — the team project has no members",
      };
    }
    return {
      workflowId: w.id,
      ownerEmail: top.email,
      ownerName: fullName(top),
      source: 'project-member',
      memberRole: top.role,
      reason: null,
    };
  });
}
