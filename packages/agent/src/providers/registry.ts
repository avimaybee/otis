/**
 * @otis/agent/providers/registry
 * Operator-maintained model registry for Plan 005.
 *
 * Discovery verifies a handpicked ID; it never auto-adds entries. Operator
 * approval and successful verification are separate requirements: an entry
 * resolves for runs only when it is approved, active, fully supported on the
 * required capabilities, and backed by an available workspace credential.
 * Test fixtures inject their own registry; production code never publishes
 * test entries.
 */

import type { ProviderName, ProviderStatus } from '@otis/contracts';
import { GEMINI_ORIGIN, OPENCODE_GO_ORIGIN, type EndpointFamily, type ThinkingRequest } from './types.js';

export type CapabilityState = 'unverified' | 'supported' | 'unsupported';
export type ModelLifecycle = 'active' | 'retired';

export interface ThinkingChoice {
  id: string;
  label: string;
  request: ThinkingRequest;
  evidenceRef?: string | null;
  verifiedAt?: string | null;
}

export interface ModelThinkingControl {
  state: CapabilityState;
  choices: ThinkingChoice[];
  defaultChoiceId?: string;
  documentationUrl?: string;
  notes?: string;
}

export interface ModelCapabilities {
  text: CapabilityState;
  tools: CapabilityState;
  stream: CapabilityState;
  thoughtSummary: CapabilityState;
  audio: CapabilityState;
  thinking?: ModelThinkingControl;
  nativeAudioFormats?: Partial<Record<string, CapabilityState>>;
}

export interface ModelEntry {
  commandKey: string;
  displayName: string;
  provider: ProviderName;
  modelId: string;
  endpointFamily: EndpointFamily;
  endpointUrl: string;
  approved: boolean;
  lifecycle: ModelLifecycle;
  capabilities: ModelCapabilities;
  thinking?: ModelThinkingControl;
  /** Documented data-use behavior, so selectors never claim zero retention. */
  trainingUse: string;
  dataRetention: string;
  evidenceRef: string | null;
  verifiedAt: string | null;
}

export interface ModelRegistry {
  version: 1;
  entries: ModelEntry[];
}

export type ResolverErrorCode =
  | 'unknown_model_key'
  | 'retired_model'
  | 'unverified_model'
  | 'missing_credential'
  | 'invalid_credential';

export class ResolverError extends Error {
  public readonly code: ResolverErrorCode;

  constructor(code: ResolverErrorCode, message: string) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
  }
}

function entry(
  commandKey: string,
  displayName: string,
  provider: ProviderName,
  modelId: string,
  endpointFamily: EndpointFamily,
  endpointUrl: string,
  trainingUse: string,
  dataRetention: string,
  overrides?: {
    capabilities?: Partial<ModelCapabilities>;
    evidenceRef?: string | null;
    verifiedAt?: string | null;
  },
): ModelEntry {
  const thinking = overrides?.capabilities?.thinking ?? { state: 'unverified', choices: [] };
  return {
    commandKey,
    displayName,
    provider,
    modelId,
    endpointFamily,
    endpointUrl,
    approved: true,
    lifecycle: 'active',
    capabilities: {
      text: overrides?.capabilities?.text ?? 'unverified',
      tools: overrides?.capabilities?.tools ?? 'unverified',
      stream: overrides?.capabilities?.stream ?? 'unverified',
      thoughtSummary: overrides?.capabilities?.thoughtSummary ?? 'unverified',
      audio: overrides?.capabilities?.audio ?? 'unverified',
      thinking,
    },
    thinking,
    trainingUse,
    dataRetention,
    evidenceRef: overrides?.evidenceRef ?? null,
    verifiedAt: overrides?.verifiedAt ?? null,
  };
}

/**
 * Production allowlist: the six operator-selected models from 2026-10-01 plus
 * deepseek-v4.1-flash (proven 2026-10-03), with the two Muse entries enabled on
 * 2026-10-03 after a fresh passing smoke. glm-5.3-flash and gpt-6-luna were
 * trialed on 2026-10-03 and removed — see the note at the end of the entries.
 * Evidenced capabilities (text, tools, stream, thinking) for independently
 * proven models (gemini-3.1-flash-lite, mimo-v2.5, mimo-v2.6-pro) are published
 * as supported with dated evidence references. Audio and thought-summary stay
 * unverified on every entry; new entries stay fully unverified until a
 * controlled synthetic smoke proves their exact endpoint. New entries carry no
 * thinking descriptor, so provider default applies.
 */
export const PRODUCTION_REGISTRY: ModelRegistry = {
  version: 1,
  entries: [
    entry(
      'gemini-3.5-flash-lite',
      'Gemini 3.5 Flash-Lite',
      'gemini',
      'gemini-3.5-flash-lite',
      'gemini-interactions',
      `${GEMINI_ORIGIN}/v1beta/interactions`,
      'Paid tier: not used for training; free tier: used (see Gemini API terms)',
      'Tier-dependent; see https://ai.google.dev/gemini-api/terms',
      {
        capabilities: {
          thinking: {
            state: 'unverified',
            documentationUrl: 'https://ai.google.dev/gemini-api/docs/thinking',
            choices: [
              { id: 'minimal', label: 'Minimal', request: { kind: 'gemini_level', level: 'minimal' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'low', label: 'Low', request: { kind: 'gemini_level', level: 'low' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'medium', label: 'Medium', request: { kind: 'gemini_level', level: 'medium' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'high', label: 'High', request: { kind: 'gemini_level', level: 'high' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
            ],
          },
        },
      },
    ),
    entry(
      'gemini-3.1-flash-lite',
      'Gemini 3.1 Flash-Lite',
      'gemini',
      'gemini-3.1-flash-lite',
      'gemini-interactions',
      `${GEMINI_ORIGIN}/v1beta/interactions`,
      'Paid tier: not used for training; free tier: used (see Gemini API terms)',
      'Tier-dependent; see https://ai.google.dev/gemini-api/terms',
      {
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
          thinking: {
            state: 'supported',
            defaultChoiceId: 'minimal',
            documentationUrl: 'https://ai.google.dev/gemini-api/docs/thinking',
            choices: [
              { id: 'minimal', label: 'Minimal', request: { kind: 'gemini_level', level: 'minimal' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'low', label: 'Low', request: { kind: 'gemini_level', level: 'low' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'medium', label: 'Medium', request: { kind: 'gemini_level', level: 'medium' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'high', label: 'High', request: { kind: 'gemini_level', level: 'high' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
            ],
          },
        },
        evidenceRef: 'docs/005-live-provider-evidence.md',
        verifiedAt: '2026-10-01',
      },
    ),
    entry(
      'mimo-25',
      'MiMo V2.5',
      'opencode_go',
      'mimo-v2.5',
      'go-chat-completions',
      `${OPENCODE_GO_ORIGIN}/v1/chat/completions`,
      'Not used for training (Go docs, checked 2026-10-01)',
      '0 days (Go docs, checked 2026-10-01)',
      {
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
          thinking: {
            state: 'supported',
            defaultChoiceId: 'default',
            choices: [
              { id: 'low', label: 'Low', request: { kind: 'go_chat_effort', effort: 'low' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'medium', label: 'Medium', request: { kind: 'go_chat_effort', effort: 'medium' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'high', label: 'High', request: { kind: 'go_chat_effort', effort: 'high' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'xhigh', label: 'Extra high', request: { kind: 'go_chat_effort', effort: 'xhigh' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
            ],
          },
        },
        evidenceRef: 'docs/005-live-provider-evidence.md',
        verifiedAt: '2026-10-01',
      },
    ),
    entry(
      'mimo-26-pro',
      'MiMo V2.6 Pro',
      'opencode_go',
      'mimo-v2.6-pro',
      'go-chat-completions',
      `${OPENCODE_GO_ORIGIN}/v1/chat/completions`,
      'Not used for training (Go docs, checked 2026-10-01)',
      '0 days (Go docs, checked 2026-10-01)',
      {
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
          thinking: {
            state: 'supported',
            defaultChoiceId: 'default',
            choices: [
              { id: 'low', label: 'Low', request: { kind: 'go_chat_effort', effort: 'low' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'medium', label: 'Medium', request: { kind: 'go_chat_effort', effort: 'medium' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
              { id: 'high', label: 'High', request: { kind: 'go_chat_effort', effort: 'high' }, verifiedAt: '2026-10-03', evidenceRef: 'docs/005-live-provider-evidence.md' },
            ],
          },
        },
        evidenceRef: 'docs/005-live-provider-evidence.md',
        verifiedAt: '2026-10-01',
      },
    ),
    entry(
      'muse-12',
      'Muse Spark 1.2 Contributor',
      'opencode_go',
      'muse-spark-1.2-contributor',
      'go-responses',
      `${OPENCODE_GO_ORIGIN}/v1/responses`,
      'Submitted data may train future Meta models (Go privacy table, 2026-10-01)',
      'Not zero data retention (Go privacy table, 2026-10-01)',
      {
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
          thinking: {
            state: 'unsupported',
            choices: [],
            notes: 'OpenCode Go Responses endpoint does not support adjustable reasoning parameters.',
          },
        },
        evidenceRef: 'docs/005-live-provider-evidence.md',
        verifiedAt: '2026-10-03',
      },
    ),
    entry(
      'muse-13',
      'Muse Spark 1.3 Contributor',
      'opencode_go',
      'muse-spark-1.3-contributor',
      'go-responses',
      `${OPENCODE_GO_ORIGIN}/v1/responses`,
      'Submitted data may train future Meta models (Go privacy table, 2026-10-01)',
      'Not zero data retention (Go privacy table, 2026-10-01)',
      {
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
          thinking: {
            state: 'unsupported',
            choices: [],
            notes: 'OpenCode Go Responses endpoint does not support adjustable reasoning parameters.',
          },
        },
        evidenceRef: 'docs/005-live-provider-evidence.md',
        verifiedAt: '2026-10-03',
      },
    ),
    entry(
      'deepseek-v4.1-flash',
      'DeepSeek V4.1 Flash',
      'opencode_go',
      'deepseek-v4.1-flash',
      'go-chat-completions',
      `${OPENCODE_GO_ORIGIN}/v1/chat/completions`,
      'Not used for training (Go privacy table, checked 2026-10-03)',
      '0 days (Go privacy table, checked 2026-10-03; DeepSeek ZDR agreement valid through 2026-10-31)',
      {
        capabilities: {
          text: 'supported',
          tools: 'supported',
          stream: 'supported',
        },
        evidenceRef: 'docs/005-live-provider-evidence.md',
        verifiedAt: '2026-10-03',
      },
    ),
    // NOTE 2026-10-03: two trialed entries were removed here, docs record why:
    // - GLM 5.3 Flash (`glm-5.3-flash`, chat/completions): live smoke rejects
    //   every tool-less text request with HTTP 400 while tool-ful requests
    //   succeed, so the required text/tools/stream triple is not established.
    // - GPT 6 Luna (`gpt-6-luna`, responses): smoke blocked twice by per-model
    //   account rate limits (HTTP 429) with no capability verdict either way.
    // See docs/005-live-provider-evidence.md. Do not re-add either without a
    // passing full smoke.
  ],
};

export function createRegistry(entries: ModelEntry[]): ModelRegistry {
  const seen = new Set<string>();
  for (const item of entries) {
    if (seen.has(item.commandKey)) {
      throw new ResolverError('unknown_model_key', `Duplicate model command key '${item.commandKey}'.`);
    }
    seen.add(item.commandKey);
  }
  return { version: 1, entries: [...entries] };
}

/**
 * Resolves a chat/workspace model selection to a runnable entry. Raw provider
 * model IDs are never accepted: callers must pass an operator command key.
 */
export function resolveCommandKey(
  registry: ModelRegistry,
  commandKey: string,
  options: { credentialStatus?: ProviderStatus | null } = {},
): ModelEntry {
  const found = registry.entries.find((item) => item.commandKey === commandKey);
  if (!found) {
    throw new ResolverError('unknown_model_key', `Unknown model '${commandKey}'.`);
  }
  if (!found.approved || found.lifecycle !== 'active') {
    throw new ResolverError(
      'retired_model',
      `Model '${commandKey}' is retired; select an available model before the next run.`,
    );
  }
  const caps = found.capabilities;
  if (caps.text !== 'supported' || caps.tools !== 'supported' || caps.stream !== 'supported') {
    throw new ResolverError(
      'unverified_model',
      `Model '${commandKey}' is not verified for text, tools, and streaming yet.`,
    );
  }
  if (options.credentialStatus !== 'available') {
    throw new ResolverError(
      options.credentialStatus == null ? 'missing_credential' : 'invalid_credential',
      `Model '${commandKey}' has no available workspace credential.`,
    );
  }
  return found;
}

/** Approved, active, fully verified entries backed by an available credential. */
export function listAvailableModels(
  registry: ModelRegistry,
  credentialStatuses: Record<string, ProviderStatus | null>,
): ModelEntry[] {
  return registry.entries.filter((item) => {
    if (!item.approved || item.lifecycle !== 'active') return false;
    const caps = item.capabilities;
    if (caps.text !== 'supported' || caps.tools !== 'supported' || caps.stream !== 'supported') return false;
    return credentialStatuses[item.provider] === 'available';
  });
}

export interface TokenRates {
  source: string;
  checkedAt: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
}

/**
 * Documented per-1M-USD rates for estimate only. Gemini paid-tier Standard
 * rates and Go subscription rates as documented on 2026-10-01. A Go
 * subscription estimate is not a measured charge against remaining quota.
 */
export const DOCUMENTED_RATES_2026_10_01: Record<string, TokenRates> = {
  'gemini-3.5-flash-lite': {
    source: 'https://ai.google.dev/gemini-api/docs/pricing (paid Standard tier)',
    checkedAt: '2026-10-01',
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    cacheReadPerMillion: 0.03,
    cacheWritePerMillion: null,
  },
  'gemini-3.1-flash-lite': {
    source: 'https://ai.google.dev/gemini-api/docs/pricing (paid Standard tier, text rates)',
    checkedAt: '2026-10-01',
    inputPerMillion: 0.25,
    outputPerMillion: 1.5,
    cacheReadPerMillion: 0.025,
    cacheWritePerMillion: null,
  },
  'mimo-v2.5': {
    source: 'https://opencode.ai/docs/go/ (Go plan rates)',
    checkedAt: '2026-10-01',
    inputPerMillion: 0.14,
    outputPerMillion: 0.28,
    cacheReadPerMillion: 0.0028,
    cacheWritePerMillion: null,
  },
  'mimo-v2.6-pro': {
    source: 'https://opencode.ai/docs/go/ (Go plan rates)',
    checkedAt: '2026-10-01',
    inputPerMillion: 0.435,
    outputPerMillion: 0.87,
    cacheReadPerMillion: 0.003625,
    cacheWritePerMillion: null,
  },
  'muse-spark-1.2-contributor': {
    source: 'https://opencode.ai/docs/go/ (Go plan rates)',
    checkedAt: '2026-10-01',
    inputPerMillion: 0.1,
    outputPerMillion: 0.2,
    cacheReadPerMillion: 0.002,
    cacheWritePerMillion: null,
  },
  'muse-spark-1.3-contributor': {
    source: 'https://opencode.ai/docs/go/ (Go plan rates)',
    checkedAt: '2026-10-01',
    inputPerMillion: 0.1,
    outputPerMillion: 0.2,
    cacheReadPerMillion: 0.002,
    cacheWritePerMillion: null,
  },
};

/** Estimates USD cost; null when any priced input is unknown. Never zero. */
export function estimateCostUsd(
  usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null },
  rates: TokenRates,
): number | null {
  if (usage.inputTokens == null || usage.outputTokens == null) return null;
  let cost = (usage.inputTokens / 1_000_000) * rates.inputPerMillion;
  cost += (usage.outputTokens / 1_000_000) * rates.outputPerMillion;
  if (usage.cacheReadTokens != null) {
    if (rates.cacheReadPerMillion == null) return null;
    cost += (usage.cacheReadTokens / 1_000_000) * rates.cacheReadPerMillion;
  }
  return cost;
}
