import { describe, expect, it } from 'vitest';
import { newSong } from '../src/song';
import { searchSongs } from '../src/store';
import { parseMeter } from '../src/ui/editor';

describe('parseMeter', () => {
  it('reads n/4, n/8 and bare numbers', () => {
    expect(parseMeter('7/8')).toEqual({ beatsPerBar: 7, beatUnit: 8 });
    expect(parseMeter(' 3 / 4 ')).toEqual({ beatsPerBar: 3, beatUnit: 4 });
    expect(parseMeter('5')).toEqual({ beatsPerBar: 5, beatUnit: 4 });
    expect(parseMeter('')).toEqual({});
    expect(parseMeter('abc')).toEqual({});
  });
});

describe('searchSongs', () => {
  const song = (title: string, artist: string) => ({ ...newSong(), title, artist });
  const songs = [song('Șoseaua', 'Vama'), song('Alt Cântec', 'Holograf'), song('Bună', 'Zdob')];
  it('sorts by title and ignores case and diacritics', () => {
    expect(searchSongs(songs, '').map((s) => s.title)).toEqual(['Alt Cântec', 'Bună', 'Șoseaua']);
    expect(searchSongs(songs, 'soseaua').map((s) => s.title)).toEqual(['Șoseaua']);
    expect(searchSongs(songs, 'HOLO').map((s) => s.title)).toEqual(['Alt Cântec']);
  });
});
