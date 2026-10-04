/**
 * @otis/worker/providers/service
 * Provider resolution, turn execution, and credential verification for
 * Plan 005. D1, authorization, and credential access stay in this Worker
 * boundary; the @otis/agent package owns protocols and the registry.
 *
 * Raw keys are decrypted server-side and injected into adapter calls only.
 * They never enter responses, activity payloads, logs, or errors.
 */

import type { ProviderName, ProviderStatus } from '@otis/contracts';
import {
  CredentialError,
  decryptWorkspaceCredential,
  getCredentialMetadata,
  markCredentialStatus,
  SettingsError,
} from '@otis/identity';
import {
  GeminiInteractionsAdapter,
  OpenCodeGoAdapter,
  PRODUCTION_REGISTRY,
  probeGeminiCredential,
  probeGoCredential,
  probeGroqCredential,
  resolveCommandKey,
  resolveVoiceRoute,
  ResolverError,
  type FetchFn,
  type ModelEntry,
  type ModelRegistry,
  type ProviderAdapter,
  type ProviderEvent,
  type ResolvedModel,
  type TurnInput,
  type VoiceRouteOutcome,
  type WorkspaceSttConfig,
} from '@otis/agent';
import { getWorkspaceVoiceSettings, type StoredVoiceSettings } from '@otis/identity';

export const VERIFY_TIMEOUT_MS = 15_000;
/** Model resource fetched for Gemini key checks; no inference, no spending. */
export const GEMINI_PROBE_MODEL_ID = 'gemini-3.5-flash-lite';

export type ServiceErrorCode = 'not_member' | 'invalid_model' | 'missing_credential' | 'misconfigured';

export class ProviderServiceError extends Error {
  public readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode, message: string) {
    super(message);
    this.name = 'ProviderServiceError';
    this.code = code;
  }
}

async function requireMembership(db: D1Database, workspaceId: string, userId: string): Promise<void> {
  const member = await db
    .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(workspaceId, userId)
    .first();
  if (!member) {
    throw new ProviderServiceError('not_member', 'Caller is no longer a member of this workspace.');
  }
}

export interface PlatformKeys {
  gemini?: string;
  opencode_go?: string;
  groq?: string;
}

export function extractPlatformKeys(env: {
  GEMINI_API_KEY?: string;
  OPENCODE_API_KEY?: string;
  OPENCODE_GO_API_KEY?: string;
  GROQ_API_KEY?: string;
}): PlatformKeys {
  return {
    gemini: env.GEMINI_API_KEY?.trim() || undefined,
    opencode_go: (env.OPENCODE_API_KEY?.trim() || env.OPENCODE_GO_API_KEY?.trim()) || undefined,
    groq: env.GROQ_API_KEY?.trim() || undefined,
  };
}

/**
 * Validates a workspace default-model selection against the operator
 * registry and the workspace's persisted credential metadata. Throws
 * SettingsError('invalid_model') for unknown, retired, unverified, or
 * uncredentialed keys so the settings route stays a thin committing path.
 */
export async function validateWorkspaceDefaultModel(
  db: D1Database,
  params: {
    workspaceId: string;
    actorUserId: string;
    commandKey: string;
    registry?: ModelRegistry;
    platformKeys?: PlatformKeys;
  },
): Promise<ModelEntry> {
  await requireMembership(db, params.workspaceId, params.actorUserId).catch((err: unknown) => {
    if (err instanceof ProviderServiceError && err.code === 'not_member') {
      throw new SettingsError('not_member', 'Caller is no longer a member of this workspace.');
    }
    throw err;
  });
  const registry = params.registry ?? PRODUCTION_REGISTRY;
  let entry: ModelEntry;
  try {
    const provider = lookupProvider(registry, params.commandKey);
    const credential = await getCredentialMetadata(db, {
      workspaceId: params.workspaceId,
      provider,
    });
    const effectiveStatus = credential?.status ?? (params.platformKeys?.[provider] ? 'available' : null);
    entry = resolveCommandKey(registry, params.commandKey, { credentialStatus: effectiveStatus });
  } catch (err) {
    if (err instanceof ResolverError) {
      throw new SettingsError('invalid_model', err.message);
    }
    throw err;
  }
  return entry;
}

function lookupProvider(registry: ModelRegistry, commandKey: string): ProviderName {
  const found = registry.entries.find((item) => item.commandKey === commandKey);
  if (!found) throw new SettingsError('invalid_model', `Unknown model '${commandKey}'.`);
  return found.provider;
}

export type ModelAvailability =
  | { available: true; entry: ModelEntry }
  | { available: false; reason: 'no_model_selected' | 'not_member' | ResolverError['code'] };

/**
 * Resolves the effective model for a chat: explicit chat override first,
 * then the workspace default. Null default is a valid unconfigured state.
 */
export async function resolveModelForChat(
  db: D1Database,
  params: {
    workspaceId: string;
    actorUserId: string;
    chatId?: string;
    selectedKey?: string;
    registry?: ModelRegistry;
    platformKeys?: PlatformKeys;
  },
): Promise<ModelAvailability> {
  const registry = params.registry ?? PRODUCTION_REGISTRY;
  const member = await db
    .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(params.workspaceId, params.actorUserId)
    .first();
  if (!member) return { available: false, reason: 'not_member' };

  let key: string | null = null;
  if (params.chatId) {
    const chat = await db
      .prepare(`SELECT model_override FROM chats WHERE id = ? AND workspace_id = ?`)
      .bind(params.chatId, params.workspaceId)
      .first<{ model_override: string | null }>();
    if (chat?.model_override) key = chat.model_override;
  }
  if (!key) {
    const settings = await db
      .prepare(`SELECT default_model FROM workspace_settings WHERE workspace_id = ?`)
      .bind(params.workspaceId)
      .first<{ default_model: string | null }>();
    key = settings?.default_model ?? null;
  }
  if (params.selectedKey !== undefined) key = params.selectedKey;
  if (!key) return { available: false, reason: 'no_model_selected' };

  const found = registry.entries.find((item) => item.commandKey === key);
  if (!found) return { available: false, reason: 'unknown_model_key' };
  try {
    const credential = await getCredentialMetadata(db, { workspaceId: params.workspaceId, provider: found.provider });
    const effectiveStatus = credential?.status ?? (params.platformKeys?.[found.provider] ? 'available' : null);
    const entry = resolveCommandKey(registry, key, { credentialStatus: effectiveStatus });
    return { available: true, entry };
  } catch (err) {
    if (err instanceof ResolverError) return { available: false, reason: err.code };
    throw err;
  }
}

function adapterFor(
  entry: ModelEntry,
  apiKey: string,
  fetchFn: FetchFn,
): ProviderAdapter {
  if (entry.provider === 'groq') {
    // Groq is an STT-only integration; it can never run a conversation turn.
    throw new ProviderServiceError('invalid_model', 'Groq is not a conversation provider.');
  }
  if (entry.endpointFamily === 'gemini-interactions') {
    return new GeminiInteractionsAdapter({ fetchFn, apiKey });
  }
  return new OpenCodeGoAdapter({ fetchFn, apiKey, endpointFamily: entry.endpointFamily });
}

export function toResolvedModel(entry: ModelEntry): ResolvedModel {
  return {
    commandKey: entry.commandKey,
    provider: entry.provider,
    modelId: entry.modelId,
    endpointFamily: entry.endpointFamily,
    endpointUrl: entry.endpointUrl,
  };
}

export interface RunTurnParams {
  workspaceId: string;
  actorUserId: string;
  entry: ModelEntry;
  wrappingKey?: CryptoKey | null;
  platformKeys?: PlatformKeys;
  input: Omit<TurnInput, 'model'>;
  fetchFn?: FetchFn;
}

/**
 * Executes one provider turn with the workspace's decrypted credential or
 * platform fallback key. The raw key is injected into the transport call and
 * never attached to yielded events. Callers stream or collect the AsyncIterable.
 */
export async function* runProviderTurn(
  db: D1Database,
  params: RunTurnParams,
): AsyncGenerator<ProviderEvent> {
  await requireMembership(db, params.workspaceId, params.actorUserId);
  let rawKey: string | null = null;
  if (params.wrappingKey) {
    try {
      const decrypted = await decryptWorkspaceCredential(db, {
        workspaceId: params.workspaceId,
        provider: params.entry.provider,
        wrappingKey: params.wrappingKey,
      });
      rawKey = decrypted.rawKey;
    } catch (err) {
      if (!params.platformKeys?.[params.entry.provider]) {
        throw err;
      }
    }
  }
  if (!rawKey && params.platformKeys) {
    rawKey = params.platformKeys[params.entry.provider] ?? null;
  }
  if (!rawKey) {
    throw new ProviderServiceError('missing_credential', `No credential available for provider '${params.entry.provider}'.`);
  }
  const adapter = adapterFor(params.entry, rawKey, params.fetchFn ?? fetch);
  yield* adapter.streamTurn({ ...params.input, model: toResolvedModel(params.entry) });
}

export interface VerifyCredentialParams {
  workspaceId: string;
  provider: ProviderName;
  wrappingKey: CryptoKey;
  actorUserId: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  sessionId?: string;
  probe?: (apiKey: string, keyVersion: number) => Promise<{ ok: boolean; status: number }>;
  /** Test-only pause after decrypt or precheck. Never set in production. */
  testHooks?: {
    afterDecrypt?: (info: { keyVersion: number; ciphertext: string }) => Promise<void>;
    afterPrecheck?: () => Promise<void>;
  };
}

export interface VerifyCredentialResult {
  verified: boolean;
  /** present when the stored key was replaced mid-verification or on failure */
  reason?: 'replaced' | 'invalid_credential' | 'rate_limited' | 'transient' | 'timeout' | 'not_member';
}

/**
 * Narrow bounded credential verification with fixed synthetic probes (Go
 * models discovery; Gemini single model resource). No inference, no prompt
 * bodies, no spending. Verification of key A never marks replacement key B:
 * the status write is guarded on the probed key version and persisted ciphertext.
 */
export async function verifyWorkspaceCredential(
  db: D1Database,
  params: VerifyCredentialParams,
): Promise<VerifyCredentialResult> {
  const member = await db
    .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
    .bind(params.workspaceId, params.actorUserId)
    .first();
  if (!member) return { verified: false, reason: 'not_member' };

  const { rawKey, keyVersion, ciphertext } = await decryptWorkspaceCredential(db, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    wrappingKey: params.wrappingKey,
  });
  if (params.testHooks?.afterDecrypt) {
    await params.testHooks.afterDecrypt({ keyVersion, ciphertext });
  }
  const fetchFn = params.fetchFn ?? fetch;
  const timeoutMs = params.timeoutMs ?? VERIFY_TIMEOUT_MS;

  let probe: { ok: boolean; status: number };
  try {
    if (params.probe) {
      probe = await params.probe(rawKey, keyVersion);
    } else if (params.provider === 'groq') {
      probe = await probeGroqCredential(fetchFn, rawKey, timeoutMs);
    } else if (params.provider === 'opencode_go') {
      probe = await probeGoCredential(fetchFn, rawKey, params.sessionId ?? `verify_${params.workspaceId}`, timeoutMs);
    } else {
      probe = await probeGeminiCredential(fetchFn, rawKey, GEMINI_PROBE_MODEL_ID, timeoutMs);
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      return { verified: false, reason: 'timeout' };
    }
    return { verified: false, reason: 'transient' };
  }

  try {
    const statusHooks = params.testHooks?.afterPrecheck
      ? { afterPrecheck: params.testHooks.afterPrecheck }
      : undefined;
    if (probe.ok) {
      const marked = await markCredentialStatus(db, {
        workspaceId: params.workspaceId,
        provider: params.provider,
        status: 'available',
        expectedKeyVersion: keyVersion,
        expectedCiphertext: ciphertext,
        actorUserId: params.actorUserId,
        testHooks: statusHooks,
      });
      return marked ? { verified: true } : { verified: false, reason: 'replaced' };
    }
    if (probe.status === 401 || probe.status === 403) {
      const marked = await markCredentialStatus(db, {
        workspaceId: params.workspaceId,
        provider: params.provider,
        status: 'invalid_credential',
        expectedKeyVersion: keyVersion,
        expectedCiphertext: ciphertext,
        actorUserId: params.actorUserId,
        testHooks: statusHooks,
      });
      return marked ? { verified: false, reason: 'invalid_credential' } : { verified: false, reason: 'replaced' };
    }
  } catch (err) {
    if (err instanceof CredentialError && err.code === 'not_member') {
      return { verified: false, reason: 'not_member' };
    }
    throw err;
  }
  // Rate limits, outages, and timeouts are not proof the key is invalid:
  // status is left untouched.
  if (probe.status === 429) return { verified: false, reason: 'rate_limited' };
  return { verified: false, reason: 'transient' };
}

export type CredentialStatusMap = Record<ProviderName, ProviderStatus | null>;

/** Snapshot of persisted credential statuses for registry availability, incorporating platform keys. */
export async function workspaceCredentialStatuses(
  db: D1Database,
  workspaceId: string,
  platformKeys?: PlatformKeys,
): Promise<CredentialStatusMap> {
  const out: CredentialStatusMap = { gemini: null, opencode_go: null, groq: null };
  for (const provider of ['gemini', 'opencode_go', 'groq'] as const) {
    const meta = await getCredentialMetadata(db, { workspaceId, provider });
    if (meta?.status) {
      out[provider] = meta.status;
    } else if (platformKeys?.[provider]) {
      out[provider] = 'available';
    } else {
      out[provider] = null;
    }
  }
  return out;
}

/**
 * Builds the resolver's STT configuration from persisted workspace settings
 * plus current credential status. Absent/disabled/model-less settings stay
 * null so the resolver reports voice unavailable.
 */
export function buildWorkspaceSttConfig(
  stored: StoredVoiceSettings,
  credentialStatus: ProviderStatus | null,
): WorkspaceSttConfig | null {
  if (!stored.enabled || !stored.model) return null;
  return {
    enabled: true,
    provider: 'groq',
    model: stored.model,
    credentialStatus,
    verifiedFormats: Object.fromEntries(
      stored.verified_formats.map((format) => [format, true]),
    ) as WorkspaceSttConfig['verifiedFormats'],
    transcriptionVerified: stored.verified_formats.length === 3,
  };
}

/**
 * Resolves the effective voice route for one chat/format using the persisted
 * workspace STT configuration and the selected registry entry. The route is
 * snapshotted at acceptance; this helper performs no provider probe.
 */
export async function resolveVoiceRouteForWorkspace(
  db: D1Database,
  params: { workspaceId: string; model: ModelEntry | null; audioMimeOrExt: string; platformKeys?: PlatformKeys },
): Promise<VoiceRouteOutcome> {
  const stored = await getWorkspaceVoiceSettings(db, params.workspaceId);
  const credential = await getCredentialMetadata(db, { workspaceId: params.workspaceId, provider: 'groq' });
  const effectiveStatus = credential?.status ?? (params.platformKeys?.groq ? 'available' : null);
  return resolveVoiceRoute({
    model: params.model,
    audioMimeOrExt: params.audioMimeOrExt,
    sttConfig: buildWorkspaceSttConfig(stored, effectiveStatus),
  });
}
