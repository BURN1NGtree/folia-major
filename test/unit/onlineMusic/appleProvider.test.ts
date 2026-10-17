import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTTML } from '@/utils/lyrics/parserCore';
import { getAppleCatalogId } from '@/services/onlineMusic/appleNormalize';
import { appleProvider } from '@/services/onlineMusic/appleProvider';
import { appleLibrary } from '@/services/onlineMusic/appleLibrary';
import { appleCatalog } from '@/services/onlineMusic/appleCatalog';
import type { UnifiedSong } from '@/types';
import type { ProviderCollection } from '@/types/onlineMusic';

// test/unit/onlineMusic/appleProvider.test.ts

// 歌词解析本身在 parserCore 的测试里覆盖；这里只验证 provider 是否正确取到 TTML 并转交。
vi.mock('@/utils/lyrics/parserCore', () => ({ parseTTML: vi.fn() }));

const bridge = (handler: (operation: string, params: Record<string, unknown>) => Promise<unknown>) => {
    const appleMusicRequest = vi.fn(handler);
    vi.stubGlobal('window', { electron: { appleMusicRequest } });
    return appleMusicRequest;
};

const ok = (data: unknown) => ({ ok: true, data });
const fail = (error: unknown) => ({ ok: false, error });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const appleSong = (catalogId: string | undefined): UnifiedSong => ({
    id: 'i.qQdGaLEuXeXRKWV',
    name: '七里香',
    artists: [],
    album: { id: '七里香', name: '七里香' },
    durationMs: 297_200,
    sourceRef: { kind: 'online', providerId: 'apple', mediaId: 'i.qQdGaLEuXeXRKWV', providerData: catalogId ? { catalogId } : {} },
});

describe('Apple catalog id resolution', () => {
    it('reads the catalog id from a catalog row, where playParams.id is itself the catalog id', () => {
        expect(getAppleCatalogId({
            id: '536115195',
            type: 'songs',
            attributes: { playParams: { id: '536115195', kind: 'song' } },
        })).toBe('536115195');
    });

    it('never mistakes a library id for a catalog id', () => {
        // 曲库行：playParams.id 是 `i.` 前缀的库内 id，真正的目录 id 在 catalogId 里。
        expect(getAppleCatalogId({
            id: 'i.qQdGaLEuXeXRKWV',
            type: 'library-songs',
            attributes: { playParams: { catalogId: '913927780', id: 'i.qQdGaLEuXeXRKWV', isLibrary: true } },
        })).toBe('913927780');

        // 库内 id 不带 catalogId 时，纯数字规则必须拒绝它，而不是当成目录 id 用。
        expect(getAppleCatalogId({
            id: 'i.qQdGaLEuXeXRKWV',
            attributes: { playParams: { id: 'i.qQdGaLEuXeXRKWV', isLibrary: true } },
        })).toBeUndefined();
    });
});

describe('Apple search', () => {
    it('treats a miss and an out-of-range offset as empty pages, not as errors', async () => {
        bridge(() => Promise.resolve(ok({ results: {} })));
        expect(await appleProvider.search!.searchSongs('zzzqqq', 5, 0))
            .toEqual({ items: [], total: 0, hasMore: false, nextOffset: 0 });

        bridge(() => Promise.resolve(ok({ results: { songs: {} } })));
        expect(await appleProvider.search!.searchSongs('jay', 5, 500))
            .toEqual({ items: [], total: 0, hasMore: false, nextOffset: 500 });
    });

    it('pages by the next link, because a search group carries no total', async () => {
        const appleMusicRequest = bridge(() => Promise.resolve(ok({
            results: { songs: { next: '/v1/catalog/cn/search?offset=1', data: [{ id: '1', attributes: { name: '七里香' } }] } },
        })));
        const page = await appleProvider.search!.searchSongs('七里香', 1, 0);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].name).toBe('七里香');
        expect(page.total).toBeUndefined();
        expect(page.hasMore).toBe(true);
        expect(appleMusicRequest).toHaveBeenCalledWith('catalog_search', { term: '七里香', types: 'songs', limit: 1, offset: 0 });
    });

    it('skips the request entirely for a blank term', async () => {
        const appleMusicRequest = bridge(() => Promise.resolve(ok({})));
        expect((await appleProvider.search!.searchSongs('   ', 5, 0)).items).toEqual([]);
        expect(appleMusicRequest).not.toHaveBeenCalled();
    });
});

describe('Apple lyrics', () => {
    it('answers "no lyrics" rather than failing when Apple returns 404 for a track', async () => {
        // 真实形态：{errors:[{code:"40403", title:"No related resources"}]} → 桥映射成 unsupported。
        bridge(() => Promise.resolve(fail({ code: 'unsupported', httpStatus: 404, message: 'Apple Music song_lyrics failed with HTTP 404' })));
        expect(await appleProvider.lyrics!.getLyrics(appleSong('913927780')))
            .toEqual({ lyrics: null, isPureMusic: false });
    });

    it('still surfaces real failures from the lyrics endpoint', async () => {
        bridge(() => Promise.resolve(fail({ code: 'auth-required', httpStatus: 401, message: 'failed with HTTP 401' })));
        await expect(appleProvider.lyrics!.getLyrics(appleSong('913927780'))).rejects.toMatchObject({ code: 'auth-required' });
    });

    it('does not call the endpoint at all for the library songs that have no catalog id', async () => {
        const appleMusicRequest = bridge(() => Promise.resolve(ok({ data: [] })));
        expect(await appleProvider.lyrics!.getLyrics(appleSong(undefined))).toEqual({ lyrics: null, isPureMusic: false });
        expect(appleMusicRequest).not.toHaveBeenCalled();
    });

    it('parses the TTML payload and flags an explicit pure-music notice', async () => {
        const appleMusicRequest = bridge(() => Promise.resolve(ok({ data: [{ attributes: { ttml: '<tt/>' } }] })));

        vi.mocked(parseTTML).mockReturnValue({ lines: [{ fullText: '窗外的麻雀' }] } as never);
        expect(await appleProvider.lyrics!.getLyrics(appleSong('913927780'))).toEqual({
            lyrics: { lines: [{ fullText: '窗外的麻雀' }] },
            isPureMusic: false,
        });
        expect(parseTTML).toHaveBeenCalledWith('<tt/>');
        expect(appleMusicRequest).toHaveBeenCalledWith('song_lyrics', { id: '913927780' });

        vi.mocked(parseTTML).mockReturnValue({ lines: [{ fullText: '纯音乐，请欣赏' }] } as never);
        expect((await appleProvider.lyrics!.getLyrics(appleSong('913927780'))).isPureMusic).toBe(true);
    });

    it('treats an empty ttml payload as no lyrics', async () => {
        bridge(() => Promise.resolve(ok({ data: [{ attributes: { ttml: '   ' } }] })));
        expect(await appleProvider.lyrics!.getLyrics(appleSong('1'))).toEqual({ lyrics: null, isPureMusic: false });
        expect(parseTTML).not.toHaveBeenCalled();
    });
});

describe('Apple library', () => {
    it('passes meta.total through and marks own playlists', async () => {
        const appleMusicRequest = bridge(() => Promise.resolve(ok({
            data: [{ id: 'p.1', type: 'library-playlists', attributes: { name: '常', canEdit: true } }],
            meta: { total: 22 },
            next: '/v1/me/library/playlists?offset=1',
        })));
        const page = await appleLibrary.getUserPlaylists('me', 1, 0);
        expect(page.total).toBe(22);
        expect(page.hasMore).toBe(true);
        expect(page.items[0]).toMatchObject({ providerId: 'apple', id: 'p.1', name: '常', type: 'playlist', isOwned: true });
        expect(appleMusicRequest).toHaveBeenCalledWith('library_playlists', { limit: 1, offset: 0 });
    });

    it('fails loudly when a library response loses its data array', async () => {
        // 这是上游形态变了，不是「没有歌单」——不能拿空列表糊过去。
        bridge(() => Promise.resolve(ok({ meta: { total: 0 } })));
        await expect(appleLibrary.getUserAlbums!('me', 10, 0)).rejects.toMatchObject({ code: 'invalid-response' });
    });
});

describe('Apple catalog', () => {
    const localPlaylist: ProviderCollection = {
        providerId: 'apple', id: 'p.DV7rLXos4P46GgY', name: '本地', type: 'playlist',
        providerData: { hasCatalog: true },
    };

    it('turns a 404 on playlist tracks into an empty page', async () => {
        // 实测：纯本地歌单详情 200、`/tracks` 404。请求照发，让上游自己回答。
        const appleMusicRequest = bridge(() => Promise.resolve(fail({ code: 'unsupported', httpStatus: 404 })));
        expect(await appleCatalog.getPlaylistTracks!('p.DV7rLXos4P46GgY', 100, 0, localPlaylist))
            .toEqual({ items: [], total: 0, hasMore: false, nextOffset: 0 });
        expect(appleMusicRequest).toHaveBeenCalledWith('library_playlist_tracks',
            { id: 'p.DV7rLXos4P46GgY', limit: 100, offset: 0 });
    });

    it('does not swallow other playlist-track failures as an empty page', async () => {
        // 把 401 伪装成「这张歌单是空的」会让界面说谎；只有 404 才是「没有云端曲目」。
        bridge(() => Promise.resolve(fail({ code: 'auth-required', httpStatus: 401 })));
        await expect(appleCatalog.getPlaylistTracks!('p.1', 100, 0)).rejects.toMatchObject({ code: 'auth-required' });
    });

    it('never short-circuits on hasCatalog, which does not mean what it looks like', async () => {
        // 回归用例：曾经用 `hasCatalog === false` 预判纯本地歌单，结果把 111 首云端曲目的
        // 「喜爱歌曲」跳成了空列表。实测 22 张里 hasCatalog=false 的那张是 200/111 首，
        // 真正 404 的「本地」反倒是 true（tools/am/am-playlist-truth.mjs）。
        const appleMusicRequest = bridge(() => Promise.resolve(ok({ data: [{ id: 'i.a', attributes: { name: '七里香' } }], meta: { total: 111 } })));
        const page = await appleCatalog.getPlaylistTracks!('p.1', 100, 0, { ...localPlaylist, providerData: { hasCatalog: false } });
        expect(page.total).toBe(111);
        expect(page.items[0].name).toBe('七里香');
        expect(appleMusicRequest).toHaveBeenCalled();
    });

    it('reads recommended playlists from the catalog side', async () => {
        // 首页「专属推荐歌单」的 id 是 `pl.pm-` 前缀：它们不在用户曲库里，
        // `/v1/me/library/playlists/{id}/tracks` 恒 404（于是界面显示「暂无内容」）。
        // 这类 id 只能走目录端点的播放列表。
        const appleMusicRequest = bridge(() => Promise.resolve(ok({
            data: [{ id: 'i.a', attributes: { name: 'Full Moon Full Life' } }],
            meta: { total: 1 },
        })));
        const page = await appleCatalog.getPlaylistTracks!('pl.pm-7cd15d345a6ed1ef7478bea24e69e485', 100, 0);
        expect(page.items[0].name).toBe('Full Moon Full Life');
        expect(appleMusicRequest).toHaveBeenCalledWith('catalog_playlist_tracks',
            { id: 'pl.pm-7cd15d345a6ed1ef7478bea24e69e485', limit: 100, offset: 0 });
    });

    it('reads a recommended playlist detail from the catalog side', async () => {
        const appleMusicRequest = bridge(() => Promise.resolve(ok({ data: [{ id: 'pl.pm-1', attributes: { name: '放松歌单' } }] })));
        expect(await appleCatalog.getPlaylistDetail!('pl.pm-1')).toMatchObject({ id: 'pl.pm-1', name: '放松歌单' });
        expect(appleMusicRequest).toHaveBeenCalledWith('catalog_playlist', { id: 'pl.pm-1' });
    });

    it('unwraps the single-object detail envelope', async () => {
        bridge(() => Promise.resolve(ok({ data: [{ id: 'p.1', type: 'library-playlists', attributes: { name: '常', trackCount: 18 } }] })));
        expect(await appleCatalog.getPlaylistDetail!('p.1')).toMatchObject({ id: 'p.1', name: '常', trackCount: 18 });
    });
});
