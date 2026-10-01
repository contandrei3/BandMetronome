import type { FirebaseOptions } from 'firebase/app';
import type { Song } from './song';
import { readLocalLibrary, type Library, type LibraryStore } from './store';

/**
 * Song library in Cloud Firestore: `songs/{id}` and the setlist in
 * `meta/setlist`. Firestore's persistent cache keeps a copy on the device,
 * so the library still opens and edits are queued when the venue has no
 * internet. Sign-in is anonymous: the app is used by one band only.
 *
 * Firebase is loaded on demand so the metronome itself starts fast.
 */
export async function createFirebaseStore(config: FirebaseOptions): Promise<LibraryStore> {
  const [{ initializeApp }, { getAuth, signInAnonymously }, fs] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ]);
  const app = initializeApp(config);
  await signInAnonymously(getAuth(app));
  const db = fs.initializeFirestore(app, {
    localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    // Optional song fields are left undefined rather than deleted.
    ignoreUndefinedProperties: true,
  });
  const songsCol = fs.collection(db, 'songs');
  const setlistDoc = fs.doc(db, 'meta', 'setlist');

  // First time online: move songs created on this device before Firebase was set up.
  const remote = await fs.getDocs(songsCol);
  const local = readLocalLibrary();
  if (remote.empty && local.songs.length > 0) {
    const batch = fs.writeBatch(db);
    for (const s of local.songs) batch.set(fs.doc(songsCol, s.id), s);
    batch.set(setlistDoc, { ids: local.setlist });
    await batch.commit();
  }

  return {
    kind: 'cloud',
    subscribe(cb) {
      const lib: Library = { songs: [], setlist: [] };
      let songsReady = false;
      let setlistReady = false;
      const emit = () => songsReady && setlistReady && cb({ songs: [...lib.songs], setlist: [...lib.setlist] });
      const offSongs = fs.onSnapshot(songsCol, (snap) => {
        lib.songs = snap.docs.map((d) => d.data() as Song);
        songsReady = true;
        emit();
      });
      const offSetlist = fs.onSnapshot(setlistDoc, (snap) => {
        lib.setlist = (snap.data()?.ids as string[] | undefined) ?? [];
        setlistReady = true;
        emit();
      });
      return () => {
        offSongs();
        offSetlist();
      };
    },
    async saveSong(song: Song) {
      await fs.setDoc(fs.doc(songsCol, song.id), song);
    },
    async deleteSong(id: string) {
      const batch = fs.writeBatch(db);
      batch.delete(fs.doc(songsCol, id));
      batch.update(setlistDoc, { ids: fs.arrayRemove(id) });
      await batch.commit().catch(() => fs.deleteDoc(fs.doc(songsCol, id)));
    },
    async saveSetlist(ids: string[]) {
      await fs.setDoc(setlistDoc, { ids });
    },
  };
}
