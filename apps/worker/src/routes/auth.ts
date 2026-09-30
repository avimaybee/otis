/**
 * Authentication routes: POST /api/auth/session and DELETE /api/auth/session.
 */

import type {
  AuthSessionRequest,
  AuthSessionResponse,
  LogoutResponse,
} from '@otis/contracts';
import {
  verifyFirebaseIdToken,
  FirebaseTokenError,
  type FirebaseTokenClaims,
  type JwksResponse,
  createSession,
  revokeSession,
  createSessionCookie,
  clearSessionCookie,
  extractSessionToken,
  validateCsrfAndOrigin,
  getOrCreateUser,
  bootstrapWorkspace,
  getUserWorkspaces,
  acceptInvite,
  InviteError,
} from '@otis/identity';
import type { Env } from '../index.js';
import { jsonError, jsonSuccess } from '../middleware/errors.js';

export async function handleAuthSession(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  // 1. Enforce CSRF & Origin check for POST mutation
  if (!validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Cross-origin request rejected.', requestId);
  }

  let body: AuthSessionRequest;
  try {
    body = (await request.json()) as AuthSessionRequest;
  } catch {
    return jsonError(400, 'invalid_json', 'Request body must be valid JSON.', requestId);
  }

  const { id_token, invite_token } = body;
  if (!id_token || typeof id_token !== 'string') {
    return jsonError(422, 'invalid_payload', 'id_token string is required.', requestId);
  }

  let claims: FirebaseTokenClaims;

  // Verify Firebase ID Token via Web Crypto RS256
  // customJwks is strictly rejected in production environments
  const projectId = env.FIREBASE_PROJECT_ID || 'otis';
  let customJwks: JwksResponse | undefined;
  if (env.ENVIRONMENT !== 'production' && env.TEST_JWKS) {
    try {
      customJwks = JSON.parse(env.TEST_JWKS) as JwksResponse;
    } catch {
      // Fall back to live Google JWKS
    }
  }

  try {
    claims = await verifyFirebaseIdToken(id_token, {
      projectId,
      customJwks,
    });
  } catch (err) {
    if (err instanceof FirebaseTokenError) {
      return jsonError(
        401,
        `auth_${err.code}`,
        `Firebase token verification failed: ${err.message}`,
        requestId,
      );
    }
    return jsonError(401, 'auth_error', 'Invalid authentication token.', requestId);
  }

  // 2. Require verified email and Google sign-in provider (google.com) for ALL Otis sessions
  if (!claims.email_verified || !claims.email) {
    return jsonError(
      403,
      'unverified_email',
      'A verified email address is required to access Otis.',
      requestId,
    );
  }

  if (!claims.signInProvider || claims.signInProvider !== 'google.com') {
    return jsonError(
      403,
      'invalid_auth_provider',
      'Only Google sign-in accounts (google.com) are permitted.',
      requestId,
    );
  }

  // 3. Ensure user exists in D1
  const user = await getOrCreateUser(env.DB, {
    firebaseUid: claims.uid,
    email: claims.email,
    displayName: claims.name,
  });

  // 4. Handle invite acceptance if provided
  if (invite_token && typeof invite_token === 'string') {
    try {
      await acceptInvite(env.DB, {
        token: invite_token,
        userId: user.id,
        userEmail: claims.email,
      });
    } catch (err) {
      if (err instanceof InviteError) {
        return jsonError(
          409,
          err.code,
          `Failed to accept invite: ${err.message}`,
          requestId,
        );
      }
      return jsonError(500, 'invite_error', 'Failed to process invite.', requestId);
    }
  }

  // 4. Handle operator configured workspace bootstrap
  // Strictly requires BOOTSTRAP_OWNER_UID to be configured and match caller's UID.
  if (
    env.BOOTSTRAP_WORKSPACE_ID &&
    env.BOOTSTRAP_OWNER_UID &&
    env.BOOTSTRAP_OWNER_UID === claims.uid
  ) {
    await bootstrapWorkspace(env.DB, {
      workspaceId: env.BOOTSTRAP_WORKSPACE_ID,
      workspaceName: env.BOOTSTRAP_WORKSPACE_NAME || 'Kerning',
      ownerUid: claims.uid,
      ownerEmail: claims.email,
      ownerDisplayName: claims.name,
    });
  }

  // 5. Create server session in D1
  const { token, session } = await createSession(env.DB, user.id);
  const workspaces = await getUserWorkspaces(env.DB, user.id);

  // 6. Set HttpOnly session cookie
  const isSecure = new URL(request.url).protocol === 'https:';
  const cookieHeader = createSessionCookie(token, session.expires_at, isSecure);

  const responseBody: AuthSessionResponse = {
    status: 'ok',
    user,
    workspaces,
    session_expires_at: session.expires_at,
  };

  return jsonSuccess(responseBody, 200, {
    'Set-Cookie': cookieHeader,
    'x-request-id': requestId,
  });
}

export async function handleLogout(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  // Enforce CSRF & Origin check for DELETE mutation
  if (!validateCsrfAndOrigin(request)) {
    return jsonError(403, 'csrf_violation', 'Cross-origin request rejected.', requestId);
  }

  const token = extractSessionToken(request);
  if (token) {
    await revokeSession(env.DB, token);
  }

  const isSecure = new URL(request.url).protocol === 'https:';
  const clearCookie = clearSessionCookie(isSecure);

  const responseBody: LogoutResponse = { status: 'ok' };
  return jsonSuccess(responseBody, 200, {
    'Set-Cookie': clearCookie,
    'x-request-id': requestId,
  });
}
