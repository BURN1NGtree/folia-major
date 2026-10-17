import type { UnifiedSong } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import type { MediaId, OnlineCatalogProvider, ProviderPage } from '../../types/onlineMusic';
import { appleFirstFromResponse, applePageFromResponse, normalizeAppleCollection, normalizeAppleSong } from './appleNormalize';
import { requestApple } from './appleTransport';
import type { AppleOperation } from './appleTransport';

// src/services/onlineMusic/appleCatalog.ts

/**
 * 曲库端点只认 **library id**（`p.` / `l.` 前缀），目录端点只认纯数字 catalog id。
 * 这个文件里的 id 全部来自曲库列表，所以一律走 `/v1/me/library/...`。
 */
const songPage = async (
    operation: AppleOperation,
    id: MediaId,
    limit: number,
    offset: number,
): Promise<ProviderPage<UnifiedSong>> => {
    const response = await requestApple(operation, { id, limit, offset });
    return applePageFromResponse(response, operation, offset, limit, normalizeAppleSong);
};

/** `pl.` 开头的是 Apple 自己的推荐/个性化歌单，只在目录侧存在；`p.` 开头的是用户曲库歌单。 */
const isCatalogPlaylistId = (id: MediaId) => String(id).startsWith('pl.');

export const appleCatalog: OnlineCatalogProvider = {
    async getPlaylistTracks(id, limit, offset) {
        if (isCatalogPlaylistId(id)) return songPage('catalog_playlist_tracks', id, limit, offset);
        // 纯本地歌单（实测只有「本地」p.DV7rLXos4P46GgY）详情返回 200，但 `/tracks` 一律 404。
        // 这里刻意**不**预判：实测 `attributes.hasCatalog` 不是这个意思——它是 false 的「喜爱歌曲」
        // 有 111 首云端曲目，而真正 404 的「本地」是 true。22 张全量表见
        // `folia-study/tools/am/am-playlist-truth.mjs`。让上游自己回答，比猜字段可靠。
        try {
            return await songPage('library_playlist_tracks', id, limit, offset);
        } catch (error) {
            // 桥把 404 归为 unsupported，而本操作只有一种 404 含义：这张歌单没有云端曲目。
            // 其余错误（401/403/429/5xx/网络）照旧抛出——把它们伪装成空列表会让界面说谎。
            if (error instanceof OnlineProviderError && error.code === 'unsupported') {
                return { items: [], total: 0, hasMore: false, nextOffset: offset };
            }
            throw error;
        }
    },
    async getPlaylistDetail(id) {
        const raw = appleFirstFromResponse(
            await requestApple(isCatalogPlaylistId(id) ? 'catalog_playlist' : 'library_playlist_detail', { id }),
        );
        return raw ? normalizeAppleCollection(raw, 'playlist') : null;
    },
    getAlbumTracks: (id, limit = 50, offset = 0) => songPage('library_album_tracks', id, limit, offset),
    async getAlbumDetail(id) {
        const raw = appleFirstFromResponse(await requestApple('library_album_detail', { id }));
        return raw ? normalizeAppleCollection(raw, 'album') : null;
    },
    async getArtistDetail(id) {
        // 曲库艺人行（`r.` 前缀）只有 name，没有目录 id，`/v1/catalog/.../artists` 查不到；
        // 能查到的只有来自检索结果的目录艺人。查不到返回 null，让调用方按「无详情」处理。
        try {
            const raw = appleFirstFromResponse(await requestApple('catalog_artist', { id }));
            return raw ? normalizeAppleCollection(raw, 'artist') : null;
        } catch {
            return null;
        }
    },
    // 曲库 API 不提供「按艺人取歌 / 取专辑」，目录侧这条路径本轮也没接（见设计文档的本轮范围）。
    // 相关方法整体省略，而不是返回空列表假装成功。
};
