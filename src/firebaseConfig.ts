import type { FirebaseOptions } from 'firebase/app';

/**
 * Web app config from the Firebase console (Project settings → Your apps → Web).
 * These values are not secret: they end up in every visitor's browser anyway.
 * Access is controlled by the Firestore rules in `firestore.rules`.
 */
export const firebaseConfig: FirebaseOptions | null = {
  apiKey: 'AIzaSyCFkZHg0pSszZP7rU7WUiqdXoF3uifuD_c',
  authDomain: 'band-metronome-3c0f2.firebaseapp.com',
  projectId: 'band-metronome-3c0f2',
  storageBucket: 'band-metronome-3c0f2.firebasestorage.app',
  messagingSenderId: '440309331735',
  appId: '1:440309331735:web:c4ac47db3277f710d62952',
};
