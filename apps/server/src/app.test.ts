import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { healthResponseSchema } from '@argus/shared';
import { createApp } from './app.js';

describe('GET /api/health', () => {
  const app = createApp();

  it('responds 200 with a payload matching the shared contract', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    // The response must satisfy the same schema the web app validates against.
    const parsed = healthResponseSchema.parse(res.body);
    expect(parsed.service).toBe('argus-server');
    expect(parsed.db).toBe('ok');
    expect(parsed.status).toBe('ok');
  });
});
