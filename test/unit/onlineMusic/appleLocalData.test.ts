import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/onlineMusic/appleLocalData.test.ts — 登出的本地那半边：只删 Apple 的键、抑制标记可开可关。

const cacheKeys = vi.hoisted(() => ({
    store: new Set<string>(),
    removed: [] as string[],
}));

vi.mock('../../../src/services/db', () => ({
    getCacheKeysByPrefix: async (prefixes: string[]) => (
        Array.from(cacheKeys.store).filter(key => prefixes.some(prefix => key.startsWith(prefix)))
    ),
    removeCacheEntries: async (keys: string[]) => {
        keys.forEach(key => {
            cacheKeys.removed.push(key);
            cacheKeys.store.delete(key);
        });
    },
}));

const importModule = async () => await import('../../../src/services/onlineMusic/appleLocalData');

/** 极简 localStorage 替身：node 环境没有真正的 storage。 */
const installLocalStorage = () => {
    const map = new Map<string, string>();
    const storage = {
        get length() { return map.size; },
        key: (index: number) => Array.from(map.keys())[index] ?? null,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
        removeItem: (key: string) => { map.delete(key); },
        clear: () => map.clear(),
    };
    vi.stubGlobal('localStorage', storage);
    return map;
};

describe('purgeAppleLocalData', () => {
    beforeEach(() => {
        cacheKeys.store = new Set<string>();
        cacheKeys.removed = [];
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('只删 online_provider_apple_ 前缀的缓存，别的源纹丝不动', async () => {
        cacheKeys.store = new Set([
            'online_provider_apple_playlist_tracks_pl.x',
            'online_provider_apple_user_home_snapshot',
            'online_provider_netease_user_home_snapshot',
            'online_provider_applepie_other',
        ]);
        const map = installLocalStorage();
        map.set('online_provider:apple:home', '{}');
        map.set('online_provider:kugou:home', '{}');

        const { purgeAppleLocalData } = await importModule();
        const result = await purgeAppleLocalData();

        expect(result.cacheEntries).toBe(2);
        expect(cacheKeys.removed.sort()).toEqual([
            'online_provider_apple_playlist_tracks_pl.x',
            'online_provider_apple_user_home_snapshot',
        ]);
        // `online_provider_applepie_*` 说明前缀必须带下划线边界，不能按 `apple` 子串删。
        expect(cacheKeys.store.has('online_provider_applepie_other')).toBe(true);
        expect(cacheKeys.store.has('online_provider_netease_user_home_snapshot')).toBe(true);

        expect(result.sessionKeys).toBe(1);
        expect(map.has('online_provider:apple:home')).toBe(false);
        expect(map.get('online_provider:kugou:home')).toBe('{}');
    });

    it('没有可删的东西时返回 0，不抛错', async () => {
        installLocalStorage();
        const { purgeAppleLocalData } = await importModule();
        await expect(purgeAppleLocalData()).resolves.toEqual({ cacheEntries: 0, sessionKeys: 0 });
    });
});

describe('会话抑制标记', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('默认不抑制；登出后抑制；主动登录后解除', async () => {
        installLocalStorage();
        const { isAppleSessionSuppressed, suppressAppleSession, clearAppleSessionSuppression } = await importModule();

        expect(isAppleSessionSuppressed()).toBe(false);
        suppressAppleSession();
        expect(isAppleSessionSuppressed()).toBe(true);
        clearAppleSessionSuppression();
        expect(isAppleSessionSuppressed()).toBe(false);
    });

    it('没有 localStorage（网页构建）时不抑制也不抛错', async () => {
        vi.stubGlobal('localStorage', undefined);
        const { isAppleSessionSuppressed, suppressAppleSession } = await importModule();

        expect(isAppleSessionSuppressed()).toBe(false);
        expect(() => suppressAppleSession()).not.toThrow();
    });
});
