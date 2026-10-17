import type { OnlineMusicProvider, ProviderCollection, ProviderLyricsResult } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { isPureMusicLyricLines } from '../../utils/lyrics/pureMusic';
import { parseTTML } from '../../utils/lyrics/parserCore';
import { applePage, getAppleCatalogId, normalizeAppleCollection, normalizeAppleSong } from './appleNormalize';
import { getAppleTransportAvailability, requestApple } from './appleTransport';
import { appleCatalog } from './appleCatalog';
import { appleLibrary } from './appleLibrary';

// src/services/onlineMusic/appleProvider.ts

/** 无歌词时对外统一用的空结果。Apple 没有「纯音乐」标志位，所以不替它猜。 */
const NO_LYRICS: ProviderLyricsResult = { lyrics: null, isPureMusic: false };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const record = (value: unknown): any => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

/**
 * 目录检索的响应是 `{ results: { songs: { data, next } } }`，比曲库端点多一层。
 *
 * 实测的两个「正常但没有内容」形态，都必须当空结果而不是错误：
 *   - 没有命中：`{ results: {} }` —— songs 分组整体缺席
 *   - offset 超出末尾：`{ results: { songs: {} } }` —— 分组在，但没有 data
 * 而且检索分组**没有** total，只有 next，所以分页判断交给 applePage 的 next 分支。
 */
const searchSongsPage = (response: unknown, offset: number, limit: number) => {
    const group = record(record(response).results).songs;
    const data = record(group).data;
    if (!Array.isArray(data) || data.length === 0) {
        return { items: [], total: 0, hasMore: false, nextOffset: offset };
    }
    return applePage(data.map(normalizeAppleSong), undefined, offset, limit, record(group).next);
};

/** Apple 的推荐响应里，每个分组把成员放在 relationships.contents.data。 */
const fetchRecommendationGroups = async (): Promise<Array<{ title: string; contents: any[] }>> => {
    const response = record(await requestApple('me_recommendations', { limit: 20 }));
    const groups = Array.isArray(response.data) ? response.data : [];
    return groups.map((group: any) => {
        const titleRecord = record(record(group).attributes).title;
        const title = text(titleRecord && typeof titleRecord === 'object' ? record(titleRecord).stringForDisplay : titleRecord);
        const data = record(record(record(group).relationships).contents).data;
        return { title, contents: Array.isArray(data) ? data : [] };
    });
};

/**
 * 摊平所有分组的资源行。分组标题是 Apple 首页那一栏的标题（「专属推荐歌单」「专属电台推荐」
 * 「最近播放」…），上层要「只要某一栏」时按标题挑，而不是把整页都塞进一个页签。
 */
const fetchRecommendationContents = async (titleMatch?: string): Promise<any[]> => {
    const groups = await fetchRecommendationGroups();
    const picked = titleMatch ? groups.filter(group => group.title.includes(titleMatch)) : groups;
    const contents: any[] = [];
    (picked.length > 0 ? picked : groups).forEach(group => contents.push(...group.contents));
    return contents;
};

/** 摊平后按资源行类型取一类，并按 id 去重（同一张歌单可能出现在多个分组里）。 */
const collectByType = (contents: any[], rowType: string): any[] => {
    const seen = new Set<string>();
    const items: any[] = [];
    contents.forEach(item => {
        if (text(record(item).type) !== rowType) return;
        const id = text(record(item).id);
        if (!id || seen.has(id)) return;
        seen.add(id);
        items.push(item);
    });
    return items;
};

/** 电台资源 → 集合。id 就是 station id（`ra.…`），播放时原样交给 MusicKit.setQueue({ station })。 */
const toStationCollection = (raw: unknown): ProviderCollection | null => {
    const item = record(raw);
    const attributes = record(item.attributes);
    const id = text(item.id);
    const name = text(attributes.name) || text(attributes.title);
    if (!id || !name) return null;
    const artwork = record(attributes.artwork);
    const coverUrl = text(artwork.url);
    const kind = text(attributes.kind);
    return {
        providerId: 'apple',
        id: id as ProviderCollection['id'],
        name,
        type: 'radio',
        ...(coverUrl ? { coverUrl: coverUrl.replace(/{w}x{h}/g, '600x600') } : {}),
        providerData: { stationId: id, kind: kind || null },
    };
};

export const appleProvider: OnlineMusicProvider = {
    id: 'apple',
    displayName: 'Apple Music',
    shortName: 'Apple',
    getAvailability: getAppleTransportAvailability,
    capabilities: {
        search: true,
        // 本轮是只读数据层：音频由用户自己的浏览器播放，Folia 不取音频、不控播放。
        playback: false,
        lyrics: true,
        // 外观上是「需要账户的源」，实际登录态由用户自己的浏览器持有，Folia 只读不写。
        // 必须是 true：capabilities.auth 会变成摘要里的 requiresAccount，而 false 会被 UI
        // 判成「无账户源」并显示无账户面板 —— 那样曲库一张歌单也不会渲染，不是「不需要登录」。
        // 判定路径：src/library/core/model/onlineProviderAccountView.ts:10（isAccountless）与 :24。
        auth: true,
        userLibrary: true,
        playlists: true,
        albums: true,
        artists: true,
        recommendations: true,
        mutations: false,
        playlistTrackMutations: false,
        // 本机 1096 首曲库歌曲的歌词实测全是 itunes:timing="Line"（逐行），没有抽到逐字样本。
        // 声明 false 是不替上游许愿；真遇到 Word timing 时，parseTTML 仍会逐首报出 isWordByWord。
        wordByWordLyrics: false,
        likes: false,
        userAlbums: true,
    },
    normalizeSong: normalizeAppleSong,
    normalizeCollection: normalizeAppleCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    search: {
        async searchSongs(query, limit, offset) {
            const term = query.trim();
            if (!term) return { items: [], total: 0, hasMore: false, nextOffset: offset };
            const response = await requestApple('catalog_search', { term, types: 'songs', limit, offset });
            return searchSongsPage(response, offset, limit);
        },
    },
    lyrics: {
        async getLyrics(song) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'apple') {
                throw new OnlineProviderError('unsupported', 'Song does not belong to Apple Music', 'apple');
            }
            // 歌词端点只认目录 id。1096 首曲库歌曲里有 10 首没有 catalogId，
            // 那类歌曲注定取不到歌词 —— 这是已知边界，不是故障。
            const catalogId = getAppleCatalogId(song);
            if (!catalogId) return NO_LYRICS;

            let response: unknown;
            try {
                response = await requestApple('song_lyrics', { id: catalogId });
            } catch (error) {
                // 没有歌词的曲目上游回 404（errors[0].code 40403，标题 "No related resources"），
                // 桥把它映射成 unsupported。「这首歌没有歌词」是正常答案而不是失败，
                // 所以只吞这一种；鉴权、限流、网络等一律照常抛出。
                if (error instanceof OnlineProviderError && error.code === 'unsupported') return NO_LYRICS;
                throw error;
            }

            const ttml = record(record(record(response).data?.[0]).attributes).ttml;
            if (typeof ttml !== 'string' || !ttml.trim()) return NO_LYRICS;

            const lyrics = parseTTML(ttml);
            return { lyrics, isPureMusic: isPureMusicLyricLines(lyrics.lines) };
        },
    },
    /**
     * 登录态是**读**出来的，不是在这里建立的：两个令牌只在用户自己的浏览器页面里，
     * 桥每次取数前读一次 MusicKit.isAuthorized。所以没有扫码流程（getQrLoginMethods 不实现）。
     */
    auth: {
        async getLoginStatus() {
            const session = record(await requestApple('session', {}));
            if (session.auth !== true) return null;
            const storefront = typeof session.sf === 'string' ? session.sf.toUpperCase() : '';
            // MusicKit 不暴露 Apple ID 昵称，所以这里不编一个：用 storefront 让用户能分辨登录的是哪个区。
            return { id: 'me', nickname: storefront ? `Apple Music (${storefront})` : 'Apple Music' };
        },
        /**
         * 刻意什么都不做：会话在用户的浏览器里，Folia 既不持有它也无权销毁它 ——
         * 点一下 Folia 的「退出登录」就把用户在 music.apple.com 上登出是越权的。
         * 本地那半边（账户快照）由 useAppleLibrary.logout 负责清理。
         */
        async logout() {},
    },
    /**
     * 个性化首页数据。Apple 把首页所有分组合并成一个响应：
     *   group.attributes.title / group.relationships.contents.data[]（playlists / albums / stations…）
     * 三块各自解析，互不牵连：某一块解析不了只让那一块为空。
     */
    recommendations: {
        /**
         * 「专属推荐歌单」等分组里的 playlist 资源。
         * 不按标题挑组：标题随语言/账号变（中文站是「专属推荐歌单」「最近播放」「二次元音乐」…），
         * 但歌单资源的形状在所有组里都一样，所以把所有组里的 playlists 摊平后去重即可。
         */
        async getRecommendedCollections(limit) {
            const groups = await fetchRecommendationContents('专属推荐歌单');
            return collectByType(groups, 'playlists')
                .filter(item => text(record(item.attributes).name))
                .slice(0, Math.max(0, limit))
                .map(item => normalizeAppleCollection(item, 'playlist'));
        },
        /**
         * 电台：Apple 的「专属电台推荐」组里既有用户的私人电台（kind: 'user'），
         * 也有「探索电台」（kind: 'discovery'），还有「XX 与类似艺人」。
         * 这三类都不是歌单，也不是一首歌 —— 它们是动态流，所以标成 type: 'radio'，
         * 让上层知道「点它=在对方那边开电台」，而不是「打开一张歌单」。
         */
        async getStations(limit) {
            const groups = await fetchRecommendationContents('专属电台推荐');
            return collectByType(groups, 'stations')
                .map(toStationCollection)
                .filter((station): station is NonNullable<typeof station> => station !== null)
                .slice(0, Math.max(0, limit));
        },
    },
    catalog: appleCatalog,
    library: appleLibrary,
    // 播控与写入本轮整体不做，因此不提供 playback / mutations / recommendations。
};
