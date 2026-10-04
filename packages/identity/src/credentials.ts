/**
 * Workspace provider credentials: one encrypted key per (workspace, provider).
 * AES-256-GCM with a fresh 12-byte nonce per encryption and
 * workspace/provider/version authenticated associated data, so ciphertext
 * cannot be moved across workspaces or providers. Only status metadata ever
 * leaves this module toward clients; raw keys stay server-side.
 */

import type {
  ProviderCredentialMetadata,
  ProviderName,
  ProviderStatus,
} from '@otis/contracts';
import { base64UrlDecode, base64UrlEncode } from './crypto.js';

export type CredentialErrorCode =
  | 'unknown_provider'
  | 'invalid_key_material'
  | 'credential_not_found'
  | 'decrypt_failed'
  | 'invalid_version'
  | 'not_member';

export class CredentialError extends Error {
  public readonly code: CredentialErrorCode;

  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

const PROVIDERS: ProviderName[] = ['gemini', 'opencode_go', 'groq'];
const NONCE_BYTES = 12;
const WRAPPING_KEY_BYTES = 32;

function toArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function aadBytes(workspaceId: string, provider: ProviderName, keyVersion: number): Uint8Array<ArrayBuffer> {
  return toArrayBuffer(
    new TextEncoder().encode(`otis-cred|${workspaceId}|${provider}|v${keyVersion}`),
  );
}

/**
 * Imports the operator wrapping key (base64url of 32 raw bytes) for AES-GCM.
 * The wrapping key lives in Worker secrets, never in D1 or the client.
 */
export async function importWrappingKey(keyMaterial: string): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(keyMaterial);
  } catch {
    throw new CredentialError('invalid_key_material', 'Wrapping key is not valid base64url.');
  }
  if (bytes.length !== WRAPPING_KEY_BYTES) {
    throw new CredentialError(
      'invalid_key_material',
      `Wrapping key must decode to ${WRAPPING_KEY_BYTES} bytes.`,
    );
  }
  // Copy into a fresh ArrayBuffer: base64UrlDecode may return a view over a
  // larger pool, which WebCrypto rejects as invalid key data.
  const copy = new Uint8Array(WRAPPING_KEY_BYTES);
  copy.set(bytes);
  return crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface EncryptedCredential {
  ciphertext_b64: string;
  nonce_b64: string;
  key_version: number;
}

export async function encryptProviderKey(
  wrappingKey: CryptoKey,
  params: { workspaceId: string; provider: ProviderName; rawKey: string; keyVersion: number },
): Promise<EncryptedCredential> {
  if (!PROVIDERS.includes(params.provider)) {
    throw new CredentialError('unknown_provider', `Unknown provider '${params.provider}'.`);
  }
  if (!Number.isInteger(params.keyVersion) || params.keyVersion < 1) {
    throw new CredentialError('invalid_version', 'Key version must be a positive integer.');
  }
  const nonce = new Uint8Array(new ArrayBuffer(NONCE_BYTES));
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aadBytes(params.workspaceId, params.provider, params.keyVersion) },
    wrappingKey,
    toArrayBuffer(new TextEncoder().encode(params.rawKey)),
  );
  return {
    ciphertext_b64: base64UrlEncode(new Uint8Array(ciphertext)),
    nonce_b64: base64UrlEncode(nonce),
    key_version: params.keyVersion,
  };
}

export async function decryptProviderKey(
  wrappingKey: CryptoKey,
  params: {
    workspaceId: string;
    provider: ProviderName;
    keyVersion: number;
    ciphertext_b64: string;
    nonce_b64: string;
  },
): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(base64UrlDecode(params.nonce_b64)),
        additionalData: aadBytes(params.workspaceId, params.provider, params.keyVersion),
      },
      wrappingKey,
      toArrayBuffer(base64UrlDecode(params.ciphertext_b64)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new CredentialError(
      'decrypt_failed',
      'Credential could not be decrypted with this key, workspace, provider, or version.',
    );
  }
}

function toMetadata(row: Record<string, unknown>): ProviderCredentialMetadata {
  return {
    provider: row['provider'] as ProviderName,
    status: row['status'] as ProviderStatus,
    last_verified_at: row['last_verified_at'] ? String(row['last_verified_at']) : null,
    key_version: Number(row['key_version']),
  };
}

/**
 * Stores (or replaces) a workspace provider key. The raw key is encrypted
 * before the batch runs and never persisted or logged. Replacement resets
 * status to unverified: a new key must prove itself before use.
 */
export async function setWorkspaceCredential(
  db: D1Database,
  params: {
    workspaceId: string;
    provider: ProviderName;
    rawKey: string;
    wrappingKey: CryptoKey;
    keyVersion: number;
    actorUserId: string;
  },
): Promise<ProviderCredentialMetadata> {
  if (!params.rawKey || params.rawKey.length > 2048) {
    throw new CredentialError('invalid_key_material', 'Provider key must be 1-2048 characters.');
  }
  const enc = await encryptProviderKey(params.wrappingKey, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    rawKey: params.rawKey,
    keyVersion: params.keyVersion,
  });
  // Replacement resets status to unverified: a new key must prove itself.
  await storeEncryptedCredential(db, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    enc,
    actorUserId: params.actorUserId,
    resetStatus: true,
  });
  const row = await db
    .prepare(
      `SELECT provider, status, last_verified_at, key_version
       FROM provider_credentials WHERE workspace_id = ? AND provider = ?`
    )
    .bind(params.workspaceId, params.provider)
    .first<Record<string, unknown>>();
  if (!row) throw new CredentialError('credential_not_found', 'Credential was not stored.');
  return toMetadata(row);
}

/**
 * Status-only read for clients: never returns ciphertext, nonce, or raw keys.
 */
export async function getCredentialMetadata(
  db: D1Database,
  params: { workspaceId: string; provider: ProviderName },
): Promise<ProviderCredentialMetadata | null> {
  const row = await db
    .prepare(
      `SELECT provider, status, last_verified_at, key_version
       FROM provider_credentials WHERE workspace_id = ? AND provider = ?`
    )
    .bind(params.workspaceId, params.provider)
    .first<Record<string, unknown>>();
  return row ? toMetadata(row) : null;
}

/**
 * Server-side decryption for provider calls (and rotation). Callers must
 * hold the current wrapping key and never forward the result to a client.
 */
export async function decryptWorkspaceCredential(
  db: D1Database,
  params: { workspaceId: string; provider: ProviderName; wrappingKey: CryptoKey },
): Promise<{ rawKey: string; keyVersion: number; ciphertext: string; nonce: string }> {
  const row = await db
    .prepare(
      `SELECT encrypted_key, key_nonce, key_version
       FROM provider_credentials WHERE workspace_id = ? AND provider = ?`
    )
    .bind(params.workspaceId, params.provider)
    .first<Record<string, unknown>>();
  if (!row) {
    throw new CredentialError('credential_not_found', 'No credential is configured for this workspace/provider.');
  }
  const keyVersion = Number(row['key_version']);
  const ciphertext = String(row['encrypted_key']);
  const nonce = String(row['key_nonce']);
  const rawKey = await decryptProviderKey(params.wrappingKey, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    keyVersion,
    ciphertext_b64: ciphertext,
    nonce_b64: nonce,
  });
  return { rawKey, keyVersion, ciphertext, nonce };
}

/**
 * Wrapping-key rotation: decrypt with the old key, re-encrypt with the new
 * key at a higher version, and verify the round-trip before retiring the old
 * key. The new version must exceed the stored version.
 *
 * OPERATOR PROCEDURE ONLY — deliberately not exposed as a workspace API
 * route. The caller must update the deployed `CREDENTIALS_KEY` secret to the
 * new wrapping key in the same maintenance window; otherwise subsequent
 * provider calls cannot decrypt the credential. Verify decrypt-then-rotate,
 * deploy the secret, then confirm a fresh decrypt before retiring the old key.
 */
export async function rotateCredentialWrappingKey(
  db: D1Database,
  params: {
    workspaceId: string;
    provider: ProviderName;
    oldWrappingKey: CryptoKey;
    newWrappingKey: CryptoKey;
    newKeyVersion: number;
    actorUserId: string;
  },
): Promise<ProviderCredentialMetadata> {
  const { rawKey, keyVersion: currentVersion } = await decryptWorkspaceCredential(db, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    wrappingKey: params.oldWrappingKey,
  });
  if (params.newKeyVersion <= currentVersion) {
    throw new CredentialError(
      'invalid_version',
      `New key version must exceed the current version (${currentVersion}).`,
    );
  }
  // Verify the new key round-trips before touching the stored row.
  const trial = await encryptProviderKey(params.newWrappingKey, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    rawKey,
    keyVersion: params.newKeyVersion,
  });
  const check = await decryptProviderKey(params.newWrappingKey, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    keyVersion: params.newKeyVersion,
    ciphertext_b64: trial.ciphertext_b64,
    nonce_b64: trial.nonce_b64,
  });
  if (check !== rawKey) {
    throw new CredentialError('decrypt_failed', 'Rotation verification failed; stored credential unchanged.');
  }
  // Rotation preserves verification status: the key material is identical,
  // only the wrapping changed.
  await storeEncryptedCredential(db, {
    workspaceId: params.workspaceId,
    provider: params.provider,
    enc: trial,
    actorUserId: params.actorUserId,
    resetStatus: false,
  });
  const meta = await getCredentialMetadata(db, {
    workspaceId: params.workspaceId,
    provider: params.provider,
  });
  if (!meta) throw new CredentialError('credential_not_found', 'Credential was not stored.');
  return meta;
}

/**
 * Marks credential verification status (used by provider validation).
 * When expectedKeyVersion is supplied, only the matching stored version is
 * marked: a concurrent replacement keeps its own unverified status, so
 * verifying key A can never mark replacement key B valid.
 */
export async function markCredentialStatus(
  db: D1Database,
  params: {
    workspaceId: string;
    provider: ProviderName;
    status: ProviderStatus;
    expectedKeyVersion?: number;
    expectedCiphertext?: string;
    actorUserId?: string;
    testHooks?: {
      afterPrecheck?: () => Promise<void>;
    };
  },
): Promise<ProviderCredentialMetadata | null> {
  const nowIso = new Date().toISOString();
  if (params.actorUserId) {
    const member = await db
      .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
      .bind(params.workspaceId, params.actorUserId)
      .first();
    if (!member) {
      throw new CredentialError('not_member', 'Caller is no longer a member of this workspace.');
    }
  }
  if (params.testHooks?.afterPrecheck) {
    await params.testHooks.afterPrecheck();
  }
  const result = await db
    .prepare(
      `UPDATE provider_credentials SET status = ?, last_verified_at = ?, updated_at = ?
       WHERE workspace_id = ? AND provider = ?
         AND (? IS NULL OR key_version = ?)
         AND (? IS NULL OR encrypted_key = ?)
         AND (? IS NULL OR EXISTS (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))`,
    )
    .bind(
      params.status,
      nowIso,
      nowIso,
      params.workspaceId,
      params.provider,
      params.expectedKeyVersion ?? null,
      params.expectedKeyVersion ?? 0,
      params.expectedCiphertext ?? null,
      params.expectedCiphertext ?? '',
      params.actorUserId ?? null,
      params.workspaceId,
      params.actorUserId ?? '',
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    if (params.actorUserId) {
      const stillMember = await db
        .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(params.workspaceId, params.actorUserId)
        .first();
      if (!stillMember) {
        throw new CredentialError('not_member', 'Caller is no longer a member of this workspace.');
      }
    }
    return null;
  }
  return getCredentialMetadata(db, { workspaceId: params.workspaceId, provider: params.provider });
}

async function storeEncryptedCredential(
  db: D1Database,
  params: {
    workspaceId: string;
    provider: ProviderName;
    enc: EncryptedCredential;
    actorUserId: string;
    resetStatus: boolean;
  },
): Promise<void> {
  const nowIso = new Date().toISOString();
  const statusClause = params.resetStatus
    ? `'unverified', NULL`
    : `COALESCE((SELECT status FROM provider_credentials WHERE workspace_id = ? AND provider = ?), 'unverified'),
       COALESCE((SELECT last_verified_at FROM provider_credentials WHERE workspace_id = ? AND provider = ?), NULL)`;
  const statusBinds: Array<string | number> = params.resetStatus
    ? []
    : [params.workspaceId, params.provider, params.workspaceId, params.provider];
  try {
    await db.batch([
      // Guard: the actor is still a member at commit time. A removal that
      // lands between the route check and this batch aborts the write.
      db
        .prepare(
          `INSERT INTO lifecycle_guards (id, guard_ok)
           VALUES (?, (SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?))
           ON CONFLICT(id) DO UPDATE SET guard_ok = excluded.guard_ok`
        )
        .bind(`guard_life_cred_${params.workspaceId}`, params.workspaceId, params.actorUserId),
      db
        .prepare(
          `INSERT INTO provider_credentials
             (workspace_id, provider, encrypted_key, key_nonce, key_version, status, last_verified_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ${statusClause}, ?, ?)
           ON CONFLICT (workspace_id, provider) DO UPDATE SET
             encrypted_key = excluded.encrypted_key,
             key_nonce = excluded.key_nonce,
             key_version = excluded.key_version,
             status = excluded.status,
             last_verified_at = excluded.last_verified_at,
             updated_at = excluded.updated_at`
        )
        .bind(
          params.workspaceId,
          params.provider,
          params.enc.ciphertext_b64,
          params.enc.nonce_b64,
          params.enc.key_version,
          ...statusBinds,
          nowIso,
          nowIso,
        ),
      db
        .prepare(
          `INSERT INTO settings_audit (id, workspace_id, user_id, actor_user_id, scope, changed_fields_json, occurred_at)
           VALUES (?, ?, NULL, ?, 'credential', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          params.workspaceId,
          params.actorUserId,
          JSON.stringify({ provider: params.provider, key_version: params.enc.key_version }),
          nowIso,
        ),
    ]);
  } catch (err) {
    if (isGuardFailure(err)) {
      const member = await db
        .prepare(`SELECT 1 FROM workspace_users WHERE workspace_id = ? AND user_id = ?`)
        .bind(params.workspaceId, params.actorUserId)
        .first();
      if (!member) {
        throw new CredentialError('not_member', 'Caller is no longer a member of this workspace.');
      }
    }
    throw err;
  }
}

function isGuardFailure(err: unknown): boolean {
  const s = String(err);
  return (
    s.includes('SQLITE_CONSTRAINT') ||
    s.includes('guard_ok') ||
    s.includes('PRIMARY KEY')
  );
}
