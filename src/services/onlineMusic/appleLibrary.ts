import type { MediaId, OnlineLibraryProvider } from '../../types/onlineMusic';
import { applePageFromResponse, normalizeAppleCollection } from './appleNormalize';
import { requestApple } from './appleTransport';

// src/services/onlineMusic/appleLibrary.ts

/**
 * 曲库浏览。三个列表端点都自带 `{data, meta.total, next}`，分页干净，
 * 所以不像 Bodian 那样需要整表缓存 —— 直接把 offset/limit 透传给上游。
 */
export const appleLibrary: OnlineLibraryProvider = {
    async getUserPlaylists(_userId: MediaId, limit: number, offset: number) {
        // 用户 id 在本 provider 里没有意义：曲库端点由 media-user-token 决定归属，
        // 路径里不带用户。签名要求它，所以显式忽略。
        const response = await requestApple('library_playlists', { limit, offset });
        return applePageFromResponse(response, 'library_playlists', offset, limit,
            raw => normalizeAppleCollection(raw, 'playlist'));
    },
    async getUserAlbums(_userId: MediaId, limit: number, offset: number) {
        const response = await requestApple('library_albums', { limit, offset });
        return applePageFromResponse(response, 'library_albums', offset, limit,
            raw => normalizeAppleCollection(raw, 'album'));
    },
    // Apple 的「喜爱」不是一个可取回的 id 集合（它是 `/v1/me/favorites`，本轮没接），
    // 所以 getLikedSongIds / getLikedSongs 整体省略，而不是返回空集合假装「没有喜欢的歌」。
};
