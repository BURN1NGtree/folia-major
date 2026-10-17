// src/utils/externalQueue.ts

import { buildMirroredAppleSong } from '../services/onlineMusic/externalPlaybackTarget';
import type { NowPlayingQueueSnapshot, SongResult } from '../types';

/**
 * 把外部播放器的待播清单快照折成面板能直接渲染的曲目数组。
 *
 * @note 队列归外部播放器所有：这里只做「显示用」的映射，不参与队列编辑。
 *       每一行都走 buildMirroredAppleSong，所以和当前曲目同一套 id 规则，
 *       「正在播放」那一行的高亮才能对得上。
 */
export const buildExternalQueueSongs = (
    queue: NowPlayingQueueSnapshot | null,
    /** 当前曲目在对方列表里的 id：用它定位「正在播放」那一行，比快照里的 position 新 */
    currentId?: string | null,
): SongResult[] => {
    if (!queue?.items.length) {
        return [];
    }

    // 只画「正在播放 + 接下来要播的」，和 Apple Music 屏幕上那份待播清单一致：
    // 列表里 position 之前的是已经播过的历史，从 0 开始画会整体错开。
    // 快照里的 position 是取快照那一刻的位置，歌播过去两首就旧了，所以优先按当前曲目的
    // id 在列表里定位，定位不到才退回收到的 position。
    const locatedIndex = currentId
        ? queue.items.findIndex((item) => item.id === currentId)
        : -1;
    const startIndex = locatedIndex >= 0
        ? locatedIndex
        : (Number.isFinite(queue.position) && queue.position >= 0 ? queue.position : 0);

    return queue.items.slice(startIndex).map((item) => buildMirroredAppleSong({
        id: item.id,
        catalogId: item.id,
        title: item.title,
        artist: item.artist,
        album: item.album,
        coverUrl: item.coverUrl,
        durationMs: item.durationMs,
    }));
};

/** 快照里的 item 下标 → 曲目 id；用来把「点了哪一行」换回跳行命令的 index。 */
export const findExternalQueueIndexById = (
    queue: NowPlayingQueueSnapshot | null,
    songId: string | null,
): number => {
    if (!queue || !songId) {
        return -1;
    }
    return queue.items.findIndex((item) => item.id === songId);
};
