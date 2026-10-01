import type { FirebaseOptions } from 'firebase/app';

/**
 * Web app config from the Firebase console (Project settings → Your apps → Web).
 * These values are not secret: they end up in every visitor's browser anyway.
 * Access is controlled by the Firestore rules in `firestore.rules`.
 *
 * While this is null the app keeps the song library on each device only.
 */
export const firebaseConfig: FirebaseOptions | null = null;
