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
  it('ships exactly the seven operator-selected models, with evidenced capabilities published for proven models', () => {
    expect(PRODUCTION_REGISTRY.version).toBe(1);
    expect(PRODUCTION_REGISTRY.entries.map((entry) => entry.commandKey)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-preview-unverified',
      'gemini-3.1-flash-lite',
      'mimo-25',
      'mimo-26-pro',
      'muse-12',
      'muse-13',
      'deepseek-v4.1-flash',
    ]);
    const provenVerifiedAt: Record<string, string> = {
      'gemini-3.5-flash-lite': '2026-10-03',
      'gemini-3.1-flash-lite': '2026-10-01',
      'mimo-25': '2026-10-01',
      'mimo-26-pro': '2026-10-01',
      'muse-12': '2026-10-03',
      'muse-13': '2026-10-03',
      'deepseek-v4.1-flash': '2026-10-03',
    };
    for (const entry of PRODUCTION_REGISTRY.entries) {
      expect(entry.approved).toBe(true);
      expect(entry.lifecycle).toBe('active');
      expect(entry.endpointUrl.startsWith('https://')).toBe(true);
      // Audio capability reflects native support on Gemini models; OpenCode Go models are unsupported; unverified preview is unverified
      if (entry.commandKey === 'gemini-3.5-flash-lite' || entry.commandKey === 'gemini-3.1-flash-lite') {
        expect(entry.capabilities.audio).toBe('supported');
      } else if (entry.commandKey === 'gemini-preview-unverified') {
        expect(entry.capabilities.audio).toBe('unverified');
      } else {
        expect(entry.capabilities.audio).toBe('unsupported');
      }
      expect(entry.capabilities.thoughtSummary).toBe('unverified');

      const verifiedAt = provenVerifiedAt[entry.commandKey];
      if (verifiedAt) {
        expect(entry.capabilities.text).toBe('supported');
        expect(entry.capabilities.tools).toBe('supported');
        expect(entry.capabilities.stream).toBe('supported');
        expect(entry.evidenceRef).toBe('docs/005-live-provider-evidence.md');
        expect(entry.verifiedAt).toBe(verifiedAt);
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
    expect(ids).toContain('deepseek-v4.1-flash');
    // Both 2026-10-03 trial entries were removed: glm-5.3-flash failed its
    // smoke on tool-less text, gpt-6-luna was blocked by account rate limits.
    expect(ids).not.toContain('glm-5.3-flash');
    expect(ids).not.toContain('gpt-6-luna');
  });

  it('keeps the surviving 2026-10-03 Go addition verbatim on the documented endpoint shape', () => {
    const byKey = new Map(PRODUCTION_REGISTRY.entries.map((entry) => [entry.commandKey, entry]));
    const deepseek = byKey.get('deepseek-v4.1-flash')!;
    expect(deepseek.displayName).toBe('DeepSeek V4.1 Flash');
    expect(deepseek.provider).toBe('opencode_go');
    expect(deepseek.endpointFamily).toBe('go-chat-completions');
    expect(deepseek.endpointUrl).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(deepseek.trainingUse).toContain('Not used for training');
    expect(deepseek.dataRetention).toContain('0 days');
    expect(deepseek.dataRetention).toContain('2026-10-31');

    // DeepSeek thinking is evidenced low/high/max: provider default no longer applies.
    expect(deepseek.capabilities.audio).toBe('unsupported');
    expect(deepseek.capabilities.thoughtSummary).toBe('unverified');
    expect(deepseek.capabilities.thinking?.state).toBe('supported');
    expect(deepseek.capabilities.thinking?.choices.map((choice) => choice.id)).toEqual(['low', 'high', 'max']);
    for (const choice of deepseek.capabilities.thinking?.choices ?? []) {
      expect(choice.request.kind).toBe('go_chat_effort');
    }

    // Both trialed removals stay unknown, not resolvable.
    expect(byKey.has('glm-5.3-flash')).toBe(false);
    expect(byKey.has('gpt-6-luna')).toBe(false);
    expect(() =>
      resolveCommandKey(PRODUCTION_REGISTRY, 'gpt-6-luna', { credentialStatus: 'available' }),
    ).toThrowError(/Unknown model/);
  });

  it('exposes live-verified Muse reasoning efforts and qualifies MiMo controls', () => {
    const byKey = new Map(PRODUCTION_REGISTRY.entries.map((entry) => [entry.commandKey, entry]));
    for (const key of ['muse-12', 'muse-13'] as const) {
      const muse = byKey.get(key)!;
      expect(muse.capabilities.thinking?.state).toBe('supported');
      expect(muse.capabilities.thinking?.choices.map((choice) => choice.id)).toEqual([
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
      for (const choice of muse.capabilities.thinking?.choices ?? []) {
        expect(choice.request).toMatchObject({ kind: 'go_responses_effort' });
      }
      const minimal = (muse.capabilities.thinking?.choices ?? []).find((choice) => choice.id === 'minimal');
      expect(minimal?.verifiedAt).toBe('2026-10-06');
    }
    const muse13 = byKey.get('muse-13')!;
    expect(muse13.capabilities.thinking?.defaultChoiceId).toBe('xhigh');
    // MiMo gateway validates the enum without proven budget effect: hidden until resolved.
    // Only observed-accepted values are listed, and 2.6 has none at all.
    const mimo25 = byKey.get('mimo-25')!;
    expect(mimo25.capabilities.thinking?.state).toBe('unverified');
    expect(mimo25.capabilities.thinking?.choices.map((choice) => choice.id)).toEqual(['low', 'xhigh']);
    const mimo26 = byKey.get('mimo-26-pro')!;
    expect(mimo26.capabilities.thinking?.state).toBe('unverified');
    expect(mimo26.capabilities.thinking?.choices).toEqual([]);
    for (const key of ['mimo-25', 'mimo-26-pro'] as const) {
      const mimo = byKey.get(key)!;
      expect(mimo.capabilities.thinking?.notes).toContain('unverified');
    }
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
      resolveCommandKey(PRODUCTION_REGISTRY, 'gemini-preview-unverified', { credentialStatus: 'available' }),
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
    expect(resolveCommandKey(PRODUCTION_REGISTRY, 'deepseek-v4.1-flash', { credentialStatus: 'available' }).modelId).toBe(
      'deepseek-v4.1-flash',
    );
    // Muse entries enabled 2026-10-03 after a fresh passing smoke.
    expect(resolveCommandKey(PRODUCTION_REGISTRY, 'muse-12', { credentialStatus: 'available' }).modelId).toBe(
      'muse-spark-1.2-contributor',
    );
    expect(resolveCommandKey(PRODUCTION_REGISTRY, 'muse-13', { credentialStatus: 'available' }).modelId).toBe(
      'muse-spark-1.3-contributor',
    );
  });

  it('rejects duplicate command keys at registry construction', () => {
    const dupe = PRODUCTION_REGISTRY.entries[0]!;
    expect(() => createRegistry([dupe, { ...dupe }])).toThrowError(/Duplicate model command key/);
  });

  it('lists evidenced entries backed by available credentials in PRODUCTION_REGISTRY', () => {
    // Both credentials available: lists exactly the 7 proven models
    const allAvailable = listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'available', opencode_go: 'available' });
    expect(allAvailable.map((m) => m.commandKey)).toEqual([
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'mimo-25',
      'mimo-26-pro',
      'muse-12',
      'muse-13',
      'deepseek-v4.1-flash',
    ]);

    // Only Gemini available: lists 2
    const geminiOnly = listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'available', opencode_go: 'unverified' });
    expect(geminiOnly.map((m) => m.commandKey)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);

    // Only OpenCode Go available: lists 5
    const goOnly = listAvailableModels(PRODUCTION_REGISTRY, { gemini: 'unverified', opencode_go: 'available' });
    expect(goOnly.map((m) => m.commandKey)).toEqual([
      'mimo-25',
      'mimo-26-pro',
      'muse-12',
      'muse-13',
      'deepseek-v4.1-flash',
    ]);

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
