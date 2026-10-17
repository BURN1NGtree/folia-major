import { getProviderCollectionArtistLabel } from '@/library/core/model/homeCards';
import {
 describe, expect, it } from 'vitest';
import {
    APPLE_ARTWORK_DEFAULT_SIZE,
    getAppleCatalogId,
    getAppleTimestamp,
    normalizeAppleArtists,
    normalizeAppleCollection,
    normalizeAppleSong,
    resolveAppleArtworkUrl,
} from '@/services/onlineMusic/appleNormalize';
import type { UnifiedSong } from '@/types';
import type { JsonValue } from '@/types/onlineMusic';

// test/unit/onlineMusic/appleNormalize.test.ts — 夹具逐字段抄自真实曲库导出，边界都是实测命中过的（缺 catalogId、epoch 0、纯本地歌单）。

/**
 * PlaybackSourceRef 是判别联合，只有 `online` 变体带 providerData；
 * 直接对联合取属性会被 tsc 拒（vitest 不做类型检查，所以单跑测试看不出来）。
 */
const onlineProviderData = (song: UnifiedSong): Record<string, JsonValue> => {
    const sourceRef = song.sourceRef;
    if (sourceRef.kind !== 'online') throw new Error(`expected an online sourceRef, got ${sourceRef.kind}`);
    return sourceRef.providerData ?? {};
};

const ARTWORK = {
    width: 1200,
    height: 1200,
    url: 'https://is1-ssl.mzstatic.com/image/thumb/Feature5/v4/aa/bb/cc/cover.jpg/{w}x{h}bb.jpg',
};

/** 曲库歌曲：库内 id 是 `i.` 前缀，目录 id 在 playParams.catalogId 上。 */
const LIBRARY_SONG = {
    id: 'i.abcdefghijklmn',
    type: 'library-songs',
    href: '/v1/me/library/songs/i.abcdefghijklmn',
    attributes: {
        albumName: '示例专辑',
        artistName: '张三 & 李四',
        artwork: ARTWORK,
        discNumber: 1,
        durationInMillis: 234000,
        genreNames: ['流行'],
        hasLyrics: true,
        name: '示例歌曲',
        playParams: {
            id: 'i.abcdefghijklmn',
            kind: 'song',
            isLibrary: true,
            catalogId: '1440857781',
            reportingId: '1440857781',
        },
        releaseDate: '2020-01-01',
        trackNumber: 3,
    },
};

/** 1096 首里有 10 首是这样的：完全没有 catalogId。 */
const LIBRARY_SONG_WITHOUT_CATALOG_ID = {
    id: 'i.zzzzzzzzzzzzzz',
    type: 'library-songs',
    attributes: {
        albumName: '无目录 id 专辑',
        artistName: '王五',
        durationInMillis: 180000,
        hasLyrics: false,
        name: '无目录 id 歌曲',
        playParams: { id: 'i.zzzzzzzzzzzzzz', kind: 'song', isLibrary: true },
    },
};

const LIBRARY_PLAYLIST = {
    id: 'p.DV7rLXos4P46GgY',
    type: 'library-playlists',
    attributes: {
        canDelete: true,
        canEdit: true,
        dateAdded: '2024-01-01T00:00:00Z',
        hasCatalog: true,
        hasCollaboration: false,
        isPublic: false,
        lastModifiedDate: '2024-05-01T00:00:00Z',
        name: '我喜欢的音乐',
        artwork: ARTWORK,
        playParams: {
            id: 'p.DV7rLXos4P46GgY',
            kind: 'playlist',
            isLibrary: true,
            globalId: 'pl.u-1a2b3c4d',
        },
    },
};

/** 纯本地歌单：没有 artwork，详情端点还会 404。 */
const LOCAL_ONLY_PLAYLIST = {
    id: 'p.localonly000000',
    type: 'library-playlists',
    attributes: {
        canDelete: true,
        canEdit: true,
        isPublic: false,
        name: '本地',
        playParams: { id: 'p.localonly000000', kind: 'playlist', isLibrary: true },
    },
};

const LIBRARY_ALBUM = {
    id: 'l.xyz123abc',
    type: 'library-albums',
    attributes: {
        artistName: '张三',
        artwork: ARTWORK,
        // 曲库专辑常见 epoch 0，表示「从未」而不是 1970 年。
        dateAdded: '1970-01-01T00:00:00Z',
        genreNames: ['流行'],
        name: '示例专辑',
        playParams: { id: 'l.xyz123abc', kind: 'album', isLibrary: true, globalId: '1440857781' },
        releaseDate: '2020-01-01',
        trackCount: 12,
    },
};

const LIBRARY_ARTIST = {
    id: 'r.79BC4Ik',
    type: 'library-artists',
    attributes: { name: '张三' },
};

describe('appleNormalize artwork', () => {
    it('substitutes the size template so <img> never receives a literal {w}x{h}', () => {
        expect(resolveAppleArtworkUrl(ARTWORK)).toBe(
            `https://is1-ssl.mzstatic.com/image/thumb/Feature5/v4/aa/bb/cc/cover.jpg/${APPLE_ARTWORK_DEFAULT_SIZE}x${APPLE_ARTWORK_DEFAULT_SIZE}bb.jpg`,
        );
    });

    it('honours a caller-selected size', () => {
        expect(resolveAppleArtworkUrl(ARTWORK, 1200)).toContain('/1200x1200bb.jpg');
    });

    it('returns undefined instead of an empty string when artwork is absent', () => {
        expect(resolveAppleArtworkUrl(undefined)).toBeUndefined();
        expect(resolveAppleArtworkUrl({ width: 1200, height: 1200 })).toBeUndefined();
    });

    it('leaves an already-concrete URL untouched', () => {
        const fixed = 'https://is1-ssl.mzstatic.com/image/thumb/a/b/c/cover.jpg/600x600bb.jpg';
        expect(resolveAppleArtworkUrl({ url: fixed })).toBe(fixed);
    });
});

describe('appleNormalize catalog id', () => {
    it('reads playParams.catalogId from a library row', () => {
        expect(getAppleCatalogId(LIBRARY_SONG)).toBe('1440857781');
    });

    it('reports absence rather than an empty string when the row has none', () => {
        expect(getAppleCatalogId(LIBRARY_SONG_WITHOUT_CATALOG_ID)).toBeUndefined();
    });

    it('reads back the catalogId a previously normalized song kept in providerData', () => {
        expect(getAppleCatalogId(normalizeAppleSong(LIBRARY_SONG))).toBe('1440857781');
    });
});

describe('appleNormalize timestamps', () => {
    it('parses an ISO date to epoch milliseconds', () => {
        expect(getAppleTimestamp('2024-05-01T00:00:00Z')).toBe(Date.parse('2024-05-01T00:00:00Z'));
    });

    it('treats epoch 0 as "never" so the UI cannot render 1970', () => {
        expect(getAppleTimestamp('1970-01-01T00:00:00Z')).toBeUndefined();
    });

    it('treats missing and unparsable values as absent', () => {
        expect(getAppleTimestamp(undefined)).toBeUndefined();
        expect(getAppleTimestamp('')).toBeUndefined();
        expect(getAppleTimestamp('not a date')).toBeUndefined();
    });
});

describe('appleNormalize artists', () => {
    it('splits the flat artistName on the separators Apple actually uses', () => {
        expect(normalizeAppleArtists('张三 & 李四').map((artist) => artist.name)).toEqual(['张三', '李四']);
        expect(normalizeAppleArtists('张三, 李四').map((artist) => artist.name)).toEqual(['张三', '李四']);
        expect(normalizeAppleArtists('张三 feat. 李四').map((artist) => artist.name)).toEqual(['张三', '李四']);
    });

    it('returns an empty list when there is no artist name', () => {
        expect(normalizeAppleArtists(undefined)).toEqual([]);
        expect(normalizeAppleArtists('   ')).toEqual([]);
    });
});

describe('normalizeAppleSong', () => {
    it('maps a library song onto UnifiedSong with the library id as identity', () => {
        const song = normalizeAppleSong(LIBRARY_SONG);

        expect(song.id).toBe('i.abcdefghijklmn');
        expect(song.name).toBe('示例歌曲');
        expect(song.durationMs).toBe(234000);
        expect(song.artists.map((artist) => artist.name)).toEqual(['张三', '李四']);
        expect(song.album.name).toBe('示例专辑');
        expect(song.sourceRef).toMatchObject({
            kind: 'online',
            providerId: 'apple',
            mediaId: 'i.abcdefghijklmn',
        });
        expect(onlineProviderData(song).catalogId).toBe('1440857781');
        expect(onlineProviderData(song).hasLyrics).toBe(true);
        expect(onlineProviderData(song).trackNumber).toBe(3);
    });

    it('resolves the album cover so no size placeholder survives normalization', () => {
        const song = normalizeAppleSong(LIBRARY_SONG);
        expect(song.album.coverUrl).toContain('600x600bb.jpg');
        expect(song.album.coverUrl).not.toContain('{w}');
    });

    it('still normalizes a song that has no catalog id at all', () => {
        const song = normalizeAppleSong(LIBRARY_SONG_WITHOUT_CATALOG_ID);

        expect(song.id).toBe('i.zzzzzzzzzzzzzz');
        expect(song.album.coverUrl).toBeUndefined();
        expect(onlineProviderData(song).catalogId).toBeNull();
        expect(onlineProviderData(song).hasLyrics).toBe(false);
    });

    it('falls back to a usable name instead of an empty title', () => {
        expect(normalizeAppleSong({ id: 'i.x', attributes: {} }).name).toBe('Unknown Song');
    });
});

describe('normalizeAppleCollection', () => {
    it('maps a library playlist and keeps ownership and modification time', () => {
        const playlist = normalizeAppleCollection(LIBRARY_PLAYLIST);

        expect(playlist.providerId).toBe('apple');
        expect(playlist.id).toBe('p.DV7rLXos4P46GgY');
        expect(playlist.name).toBe('我喜欢的音乐');
        expect(playlist.type).toBe('playlist');
        expect(playlist.coverUrl).toContain('600x600bb.jpg');
        expect(playlist.isOwned).toBe(true);
        expect(playlist.updatedAt).toBe(Date.parse('2024-05-01T00:00:00Z'));
        expect(playlist.providerData?.globalId).toBe('pl.u-1a2b3c4d');
    });

    it('tolerates the local-only playlist that has no artwork and no catalog backing', () => {
        const playlist = normalizeAppleCollection(LOCAL_ONLY_PLAYLIST);

        expect(playlist.name).toBe('本地');
        expect(playlist.coverUrl).toBeUndefined();
        expect(playlist.updatedAt).toBeUndefined();
        expect(playlist.providerData?.hasCatalog).toBeNull();
    });

    it('does not surface epoch 0 as a 1970 modification date on albums', () => {
        const album = normalizeAppleCollection(LIBRARY_ALBUM);

        expect(album.type).toBe('album');
        expect(album.trackCount).toBe(12);
        expect(album.updatedAt).toBeUndefined();
        expect(album.providerData?.dateAdded).toBe('1970-01-01T00:00:00Z');
    });

    it('keeps the album artist so the album tab shows a name instead of 未知歌手', () => {
        const album = normalizeAppleCollection(LIBRARY_ALBUM);

        expect(album.artists?.map((entry) => entry.name)).toEqual(['张三']);
        expect(getProviderCollectionArtistLabel(album)).toBe('张三');
    });

    it('does not split an album artist name on ampersands (Simon & Garfunkel stays one artist)', () => {
        const album = normalizeAppleCollection({
            ...LIBRARY_ALBUM,
            attributes: { ...LIBRARY_ALBUM.attributes, artistName: 'Simon & Garfunkel' },
        });

        expect(album.artists?.map((entry) => entry.name)).toEqual(['Simon & Garfunkel']);
    });

    it('maps a library artist and derives its display artist entry from the name', () => {
        const artist = normalizeAppleCollection(LIBRARY_ARTIST);

        expect(artist.type).toBe('artist');
        expect(artist.name).toBe('张三');
        expect(artist.artists?.map((entry) => entry.name)).toEqual(['张三']);
    });

    it('lets an explicit type override the row type', () => {
        expect(normalizeAppleCollection(LIBRARY_ALBUM, 'playlist').type).toBe('playlist');
    });
});

describe('appleNormalize placeholder sweep', () => {
    it('never lets {w}x{h} reach any normalized output', () => {
        const serialized = JSON.stringify([
            normalizeAppleSong(LIBRARY_SONG),
            normalizeAppleSong(LIBRARY_SONG_WITHOUT_CATALOG_ID),
            normalizeAppleCollection(LIBRARY_PLAYLIST),
            normalizeAppleCollection(LOCAL_ONLY_PLAYLIST),
            normalizeAppleCollection(LIBRARY_ALBUM),
            normalizeAppleCollection(LIBRARY_ARTIST),
        ]);

        expect(serialized).not.toContain('{w}');
        expect(serialized).not.toContain('{h}');
    });
});
