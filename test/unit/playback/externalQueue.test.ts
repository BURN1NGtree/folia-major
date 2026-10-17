import { describe, it, expect } from 'vitest';
import { buildExternalQueueSongs, findExternalQueueIndexById } from '../../../src/utils/externalQueue';
import type { NowPlayingQueueSnapshot } from '../../../src/types';

// test/unit/playback/externalQueue.test.ts
// 锁的是「Folia 的待播清单 == Apple Music 屏幕上那份待播清单」这条规则：
// Apple 的 queue.items 带着已经播过的历史，从 0 开始画整体就错位了。

const queue: NowPlayingQueueSnapshot = {
    position: 4,
    items: [
        { id: 'a', title: '山海', artist: '', album: '', coverUrl: null, durationMs: 1000 },
        { id: 'b', title: '爱情转移', artist: '', album: '', coverUrl: null, durationMs: 1000 },
        { id: 'c', title: '借口', artist: '', album: '', coverUrl: null, durationMs: 1000 },
        { id: 'd', title: '群青', artist: '', album: '', coverUrl: null, durationMs: 1000 },
        { id: 'e', title: 'trust you', artist: '', album: '', coverUrl: null, durationMs: 1000 },
        { id: 'f', title: '给你一瓶魔法药水', artist: '', album: '', coverUrl: null, durationMs: 1000 },
    ],
};

const titles = (snapshot: NowPlayingQueueSnapshot, currentId?: string | null) =>
    buildExternalQueueSongs(snapshot, currentId).map(song => song.name);

describe('buildExternalQueueSongs', () => {
    it('starts from the current song, not from the first item in the list', () => {
        expect(titles(queue, 'e')).toEqual(['trust you', '给你一瓶魔法药水']);
    });

    it('follows the current song id even after the snapshot position went stale', () => {
        // 快照还是 position 2 的时候取的，歌已经播到 d：按 id 定位得到 d，用旧 position 就会多画两首已播的。
        const stale = { position: 2, items: queue.items };
        expect(titles(stale, 'd')).toEqual(['群青', 'trust you', '给你一瓶魔法药水']);
    });

    it('falls back to the snapshot position when the current song is not in the list', () => {
        expect(titles(queue, 'zzz')).toEqual(['trust you', '给你一瓶魔法药水']);
    });

    it('keeps every item when there is no position and no known current song', () => {
        expect(titles({ position: -1, items: queue.items }, null)).toHaveLength(6);
    });

    it('maps row ids so a click can be turned back into a queue index', () => {
        expect(findExternalQueueIndexById(queue, 'e')).toBe(4);
        expect(findExternalQueueIndexById(queue, 'nope')).toBe(-1);
    });
});
