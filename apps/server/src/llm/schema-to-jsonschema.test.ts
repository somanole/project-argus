import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { enrichmentOutputSchema } from '@argus/shared';
import { zodToStrictJsonSchema } from './schema-to-jsonschema.js';

describe('zodToStrictJsonSchema', () => {
  it('emits a strict schema for the enrichment output: all-required, no extra props', () => {
    const js = zodToStrictJsonSchema(enrichmentOutputSchema) as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type: string; enum?: string[]; items?: { enum?: string[] } }>;
    };
    expect(js.type).toBe('object');
    expect(js.additionalProperties).toBe(false);
    // Strict mode requires EVERY property in required.
    expect(js.required.sort()).toEqual(Object.keys(js.properties).sort());
    expect(js.required).toContain('criticalityReason');
    // Enums carried through.
    expect(js.properties.category.enum).toContain('revenue-ops');
    expect(js.properties.category.enum).toContain('other');
    expect(js.properties.criticality.enum).toEqual(['critical', 'high', 'medium', 'low']);
    // Array-of-enum.
    expect(js.properties.riskFlags.type).toBe('array');
    expect(js.properties.riskFlags.items?.enum).toContain('handles-pii');
  });

  it('fails loud on an unsupported construct (no silent wrong schema — rule 5)', () => {
    const bad = z.object({ maybe: z.string().nullable() });
    expect(() => zodToStrictJsonSchema(bad)).toThrow(/unsupported Zod type/);
  });
});
