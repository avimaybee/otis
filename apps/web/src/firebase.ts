import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  type Auth,
} from 'firebase/auth';

export interface ClientAuthConfig {
  isConfigured: boolean;
  app: FirebaseApp | null;
  auth: Auth | null;
}

export function getClientAuth(): ClientAuthConfig {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY;
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;

  if (!apiKey || !projectId) {
    return { isConfigured: false, app: null, auth: null };
  }

  const app =
    getApps().length === 0
      ? initializeApp({
          apiKey,
          authDomain:
            import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
          projectId,
          appId: import.meta.env.VITE_FIREBASE_APP_ID,
        })
      : (getApps()[0] as FirebaseApp);

  const auth = getAuth(app);
  return { isConfigured: true, app, auth };
}

/**
 * Triggers Google Sign-in popup using Firebase Auth SDK and returns the ID token.
 */
export async function signInWithGoogle(): Promise<string> {
  const { auth, isConfigured } = getClientAuth();
  if (!isConfigured || !auth) {
    throw new Error(
      'Firebase is not configured. Set VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID in .env.',
    );
  }

  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  const credential = await signInWithPopup(auth, provider);
  return await credential.user.getIdToken();
}

/**
 * Signs out from Firebase client SDK.
 */
export async function clientSignOut(): Promise<void> {
  const { auth, isConfigured } = getClientAuth();
  if (isConfigured && auth) {
    await firebaseSignOut(auth);
  }
}
