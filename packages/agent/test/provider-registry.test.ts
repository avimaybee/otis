import { describe, expect, it } from 'vitest';
import {
  createRegistry,
  DOCUMENTED_RATES_2026_10_01,
  estimateCostUsd,
  listAvailableModels,
  PRODUCTION_REGISTRY,
  resolveCommandKey,
  ResolverError,
} from '../src/providers/registry.js';

describe('operator model registry', () => {
  it('ships exactly the six operator-selected models, with evidenced capabilities published for proven models', () => {
    expect(PRODUCTION_REGISTRY.version).toBe(1);
    expect(PRODUCTION_REGISTRY.entries.map((entry) => entry.commandKey)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'mimo-25',
      'mimo-26-pro',
      'muse-12',
      'muse-13',
    ]);
    const provenKeys = new Set(['gemini-3.1-flash-lite', 'mimo-25', 'mimo-26-pro']);
    for (const entry of PRODUCTION_REGISTRY.entries) {
      expect(entry.approved).toBe(true);
      expect(entry.lifecycle).toBe('active');
      expect(entry.endpointUrl.startsWith('https://')).toBe(true);
      // Audio and thought-summary remain unverified on all models until accepted
      expect(entry.capabilities.audio).toBe('unverified');
      expect(entry.capabilities.thoughtSummary).toBe('unverified');

      if (provenKeys.has(entry.commandKey)) {
        expect(entry.capabilities.text).toBe('supported');
        expect(entry.capabilities.tools).toBe('supported');
        expect(entry.capabilities.stream).toBe('supported');
        expect(entry.evidenceRef).toBe('docs/005-live-provider-evidence.md');
        expect(entry.verifiedAt).toBe('2026-10-01');
      } else {
        expect(entry.capabilities.text).toBe('unverified');
        expect(entry.capabilities.tools).toBe('unverified');
        expect(entry.capabilities.stream).toBe('unverified');
        expect(entry.evidenceRef).toBeNull();
        expect(entry.verifiedAt).toBeNull();
      }
    }
    const ids = PRODUCTION_REGISTRY.entries.map((entry) => entry.modelId);
    expect(ids).toContain('gemini-3.5-flash-lite');
    expect(ids).toContain('mimo-v2.5');
    expect(ids).toContain('muse-spark-1.3-contributor');
  });

  it('rejects endpoint families outside the fixed approved origins', () => {
    for (const entry of PRODUCTION_REGISTRY.entries) {
      expect(
        entry.endpointUrl.startsWith('https://generativelanguage.googleapis.com') ||
          entry.endpointUrl.startsWith('https://opencode.ai/zen/go'),
      ).toBe(true);
    }
  });

  it('rejects unknown keys, raw model IDs, retired, and unverified entries', () => {
    expect(() => resolveCommandKey(PRODUCTION_REGISTRY, 'nope', { credentialStatus: 'available' })).toThrowError(
      ResolverError,
    );
    // A raw provider model ID is not a command key.
    expect(() => resolveCommandKey(PRODUCTION_REGISTRY, 'mimo-v2.5', { credentialStatus: 'available' })).toThrowError(
      /Unknown model/,
    );
    const retired = createRegistry([
      { ...PRODUCTION_REGISTRY.entries[0]!, lifecycle: 'retired' as const },
    ]);
    expect(() => resolveCommandKey(retired, 'gemini-3.5-flash-lite', { credentialStatus: 'available' })).toThrowError(
      /retired/,
    );
    // Unverified models in PRODUCTION_REGISTRY fail closed.
    expect(() =>
      resolveCommandKey(PRODUCTION_REGISTRY, 'gemini-3.5-flash-lite', { credentialStatus: 'available' }),
    ).toThrowError(/not verified/);
    expect(() =>
      resolveCommandKey(PRODUCTION_REGISTRY, 'muse-12', { credentialStatus: 'available' }),
    ).toThrowError(/not verified/);
  });

  it('resolves evidenced entries with available credentials, rejects missing or invalid credentials', () => {
    // Exercises PRODUCTION_REGISTRY directly
    expect(() => resolveCommandKey(PRODUCTION_REGISTRY, 'mimo-25')).toThrowError(/no available workspace credential/i);
    expect(() => resolveCommandKey(PRODUCTION_REGISTRY, 'mimo-25', { credentialStatus: 'invalid_credential' })).toThrowError(
      /no available workspace credential/i,
    );
    expect(resolveCommandKey(PRODUCTION_REGISTRY, 'mimo-25', { credentialStatus: 'available' }).modelId).toBe('mimo-v2.5');
    expect(resolveCommandKey(PRODUCTION_REGISTRY, 'mimo-26-pro', { credentialStatus: 'available' }).modelId).toBe('mimo-v2.6-pro');
    expect(resolveCommandKey(PRODUCTION_REGISTRY, 'gemini-3.1-flash-lite', { credentialStatus: 'available' }).modelId).toBe('gemini-3.1-flash-lite');
  });

  it('rejects duplicate command keys at registry construction', () => {
    const dupe = PRODUCTION_REGISTRY.entries[0]!;
    expect(() => createRegistry([dupe, { ...dupe }])).toThrowError(/Duplicate model command key/);
  });

  it('lists evidenced entries backed by available credentials in PRODUCTION_REGISTRY', () => {
    // Both credentials available: lists exactly the 3 proven models
    const allAvailable = listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'available', opencode_go: 'available' });
    expect(allAvailable.map((m) => m.commandKey)).toEqual(['gemini-3.1-flash-lite', 'mimo-25', 'mimo-26-pro']);

    // Only Gemini available: lists 1
    const geminiOnly = listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'available', opencode_go: 'unverified' });
    expect(geminiOnly.map((m) => m.commandKey)).toEqual(['gemini-3.1-flash-lite']);

    // Only OpenCode Go available: lists 2
    const goOnly = listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'unverified', opencode_go: 'available' });
    expect(goOnly.map((m) => m.commandKey)).toEqual(['mimo-25', 'mimo-26-pro']);

    // No credentials available: lists 0
    expect(listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'unverified', opencode_go: 'unverified' })).toHaveLength(0);
    expect(listAvailableModels(PRODUCTION_REGISTRY, {})).toHaveLength(0);
  });

  it('estimates cost from documented rates and returns null for unknowns', () => {
    const rates = DOCUMENTED_RATES_2026_10_01['mimo-v2.5']!;
    expect(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: null }, rates)).toBeCloseTo(
      0.42,
      6,
    );
    expect(estimateCostUsd({ inputTokens: null, outputTokens: 5, cacheReadTokens: null }, rates)).toBeNull();
    expect(
      estimateCostUsd({ inputTokens: 10, outputTokens: 10, cacheReadTokens: 5 }, { ...rates, cacheReadPerMillion: null }),
    ).toBeNull();
  });
});
