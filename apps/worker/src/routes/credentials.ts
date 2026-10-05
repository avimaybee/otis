/**
 * Provider credential routes: write-only replacement and status-only reads.
 * Ciphertext, nonces, and raw keys never appear in a response, log, or error.
 * Requires the CREDENTIALS_KEY wrapping key; explicit 500 when unconfigured.
 */

import type { CredentialStatusResponse, PutCredentialRequest } from '@otis/contracts';
import {
  CredentialError,
  deleteWorkspaceCredential,
  getCredentialMetadata,
  importWrappingKey,
  setWorkspaceCredential,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';
import {
  extractPlatformKeys,
  verifyWorkspaceCredential,
} from '../providers/service.js';
import { readJsonBody, requireWorkspaceScope } from './scope.js';

const PROVIDERS = ['gemini', 'opencode_go', 'groq'] as const;

async function loadWrappingKey(env: Env): Promise<CryptoKey> {
  if (!env.CREDENTIALS_KEY) {
    throw { status: 500, code: 'server_misconfigured', message: 'Credential storage is not configured.' };
  }
  try {
    return await importWrappingKey(env.CREDENTIALS_KEY);
  } catch {
    throw { status: 500, code: 'server_misconfigured', message: 'Credential storage is misconfigured.' };
  }
}

function credentialStatus(err: CredentialError): number {
  switch (err.code) {
    case 'credential_not_found':
    case 'not_member':
      return 404;
    case 'unknown_provider':
    case 'invalid_key_material':
    case 'invalid_version':
      return 422;
    default:
      return 400;
  }
}

export async function handlePutCredential(
  request: Request,
  env: Env,
  workspaceId: string,
  provider: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    return jsonError(404, 'unknown_provider', 'Unknown provider.', requestId);
  }

  const parsed = await readJsonBody(request);
  const body = parsed.ok ? (parsed.body as unknown as PutCredentialRequest) : null;
  if (!body || typeof body.key !== 'string' || !body.key) {
    return jsonError(422, 'invalid_payload', 'A non-empty key is required.', requestId);
  }

  try {
    const wrappingKey = await loadWrappingKey(env);
    const existing = await getCredentialMetadata(env.DB, {
      workspaceId,
      provider: provider as (typeof PROVIDERS)[number],
    });
    const credential = await setWorkspaceCredential(env.DB, {
      workspaceId,
      provider: provider as (typeof PROVIDERS)[number],
      rawKey: body.key,
      wrappingKey,
      // Replacement always moves to a fresh version; rotation never reuses one.
      keyVersion: (existing?.key_version ?? 0) + 1,
      actorUserId: scope.user.id,
    });
    const responseBody: CredentialStatusResponse = { status: 'ok', credential };
    return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonError(credentialStatus(err), err.code, err.message, requestId);
    }
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; code: string; message: string };
      return jsonError(e.status, e.code, e.message, requestId);
    }
    throw err;
  }
}

export async function handleDeleteCredential(
  request: Request,
  env: Env,
  workspaceId: string,
  provider: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    return jsonError(404, 'unknown_provider', 'Unknown provider.', requestId);
  }

  try {
    await deleteWorkspaceCredential(env.DB, {
      workspaceId,
      provider: provider as (typeof PROVIDERS)[number],
      actorUserId: scope.user.id,
    });
    return jsonSuccess({ status: 'ok', deleted: true }, 200, { 'x-request-id': requestId });
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonError(credentialStatus(err), err.code, err.message, requestId);
    }
    throw err;
  }
}

export async function handleGetCredentialStatus(
  request: Request,
  env: Env,
  workspaceId: string,
  provider: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId);
  if (scope instanceof Response) return scope;
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    return jsonError(404, 'unknown_provider', 'Unknown provider.', requestId);
  }
  const credential = await getCredentialMetadata(env.DB, {
    workspaceId,
    provider: provider as (typeof PROVIDERS)[number],
  });
  const platformKeys = extractPlatformKeys(env);
  const provKey = provider as (typeof PROVIDERS)[number];
  const effectiveCredential = credential ?? (platformKeys[provKey] ? {
    provider: provKey,
    status: 'available' as const,
    key_version: 1,
    last_verified_at: new Date().toISOString(),
  } : null);
  const responseBody: CredentialStatusResponse = { status: 'ok', credential: effectiveCredential };
  return jsonSuccess(responseBody, 200, { 'x-request-id': requestId });
}

/**
 * Narrow bounded credential verification: one fixed synthetic probe per
 * provider (Go models discovery; Gemini single model resource). No
 * inference, no prompt bodies, no spending. Sanitized outcome only.
 */
export async function handleVerifyCredential(
  request: Request,
  env: Env,
  workspaceId: string,
  provider: string,
  requestId: string,
): Promise<Response> {
  const scope = await requireWorkspaceScope(request, env.DB, workspaceId, requestId, { csrf: true });
  if (scope instanceof Response) return scope;
  if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
    return jsonError(404, 'unknown_provider', 'Unknown provider.', requestId);
  }

  try {
    const wrappingKey = await loadWrappingKey(env);
    const result = await verifyWorkspaceCredential(env.DB, {
      workspaceId,
      provider: provider as (typeof PROVIDERS)[number],
      wrappingKey,
      actorUserId: scope.user.id,
    });
    if (!result.verified && result.reason === 'not_member') {
      return jsonError(404, 'not_member', 'Caller is no longer a member of this workspace.', requestId);
    }
    return jsonSuccess(
      { status: 'ok', provider, verified: result.verified, reason: result.reason ?? null },
      200,
      { 'x-request-id': requestId },
    );
  } catch (err) {
    if (err instanceof CredentialError) {
      return jsonError(credentialStatus(err), err.code, err.message, requestId);
    }
    if (err && typeof err === 'object' && 'status' in err) {
      const e = err as { status: number; code: string; message: string };
      return jsonError(e.status, e.code, e.message, requestId);
    }
    throw err;
  }
}
