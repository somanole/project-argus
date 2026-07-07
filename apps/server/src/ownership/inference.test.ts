import { describe, it, expect } from 'vitest';
import type { N8nProject, N8nProjectMember, N8nUser } from '@argus/shared';
import { HttpError } from '../n8n/client.js';
import { inferOwnership, type InferenceReader } from './inference.js';

const projects: N8nProject[] = [
  { id: 'team1', name: 'Revenue Ops', type: 'team', creatorId: 'u-sam' },
  { id: 'pers1', name: 'Diana Prince <diana@n8n.io>', type: 'personal', creatorId: 'u-diana' },
  { id: 'pers2', name: 'Marco Reus <marco@n8n.io>', type: 'personal', creatorId: null },
];

const members: Record<string, N8nProjectMember[]> = {
  team1: [
    { id: 'u-priya', email: 'priya@n8n.io', firstName: 'Priya', lastName: 'Member', role: 'project:editor' },
    { id: 'u-sam', email: 'sam@n8n.io', firstName: 'Sam', lastName: 'Rivers', role: 'project:admin' },
  ],
};

const users: N8nUser[] = [
  { id: 'u-diana', email: 'diana@n8n.io', firstName: 'Diana', lastName: 'Prince', role: 'global:member' },
];

function reader(overrides: Partial<InferenceReader> = {}): InferenceReader {
  return {
    listProjectMembers: async (pid: string) => members[pid] ?? [],
    listUsers: async () => users,
    ...overrides,
  };
}

describe('inferOwnership', () => {
  it('team project → most-privileged member (admin over editor)', async () => {
    const rows = await inferOwnership(reader(), projects, [{ id: 'w1', projectId: 'team1' }]);
    expect(rows[0]).toMatchObject({ ownerEmail: 'sam@n8n.io', source: 'project-member', memberRole: 'project:admin' });
  });

  it('personal project → that person (resolved via creatorId → users)', async () => {
    const rows = await inferOwnership(reader(), projects, [{ id: 'w2', projectId: 'pers1' }]);
    expect(rows[0]).toMatchObject({ ownerEmail: 'diana@n8n.io', ownerName: 'Diana Prince', source: 'personal-project' });
  });

  it('personal project with no creator match → parse "First Last <email>" from the name', async () => {
    const rows = await inferOwnership(reader(), projects, [{ id: 'w3', projectId: 'pers2' }]);
    expect(rows[0]).toMatchObject({ ownerEmail: 'marco@n8n.io', ownerName: 'Marco Reus', source: 'personal-project' });
  });

  it('honest degradation: a 403 on members → unavailable with a user:list reason, no fabricated owner', async () => {
    const rows = await inferOwnership(
      reader({ listProjectMembers: async () => { throw new HttpError(403); } }),
      projects,
      [{ id: 'w1', projectId: 'team1' }],
    );
    expect(rows[0]?.ownerEmail).toBeNull();
    expect(rows[0]?.source).toBe('unavailable');
    expect(rows[0]?.reason).toContain('user:list');
  });

  it('personal inference still works when the users list is forbidden (name fallback)', async () => {
    const rows = await inferOwnership(
      reader({ listUsers: async () => { throw new HttpError(403); } }),
      projects,
      [{ id: 'w2', projectId: 'pers1' }],
    );
    expect(rows[0]).toMatchObject({ ownerEmail: 'diana@n8n.io', source: 'personal-project' });
  });
});
