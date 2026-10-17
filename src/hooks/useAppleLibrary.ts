import { useCallback, useEffect, useRef } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { clearProviderAccountSnapshot, loadProviderAccountSnapshot, saveProviderAccountSnapshot } from '../services/onlineMusic/providerAccountCache';
import { clearAppleMusicBrowserSession } from '../services/onlineMusic/appleBrowserSession';
import { isAppleSessionSuppressed, purgeAppleLocalData, suppressAppleSession } from '../services/onlineMusic/appleLocalData';
import { useOnlineProviderAccountStore } from '../stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '../types/onlineMusic';
import type { MediaId, ProviderCollection } from '../types/onlineMusic';

// src/hooks/useAppleLibrary.ts

const APPLE_PROVIDER_ID = 'apple';

/**
 * 拉完整份歌单列表。
 *
 * 与 bodian 同款防死循环：上游回 hasMore 却不推进 offset 时必须自己停，
 * 否则一个坏响应就能把渲染进程卡在这里转圈。
 */
const getUserPlaylists = async (userId: MediaId): Promise<ProviderCollection[]> => {
    const collections: ProviderCollection[] = [];
    let offset = 0;
    for (;;) {
        const page = await omni.getProviderUserPlaylists(APPLE_PROVIDER_ID, userId, { offset, limit: 50 });
        collections.push(...page.items);
        if (!page.hasMore || page.nextOffset <= offset) break;
        offset = page.nextOffset;
    }
    return collections;
};

/**
 * Apple Music 的曲库水合。
 *
 * 为什么这个文件必须存在：Omni 只提供「按 providerId 取数」，而「什么时候取、取回来写进哪个
 * store、缓存到哪」是每个源自己的 hook 负责的 —— UI 侧没有遍历 provider 的通用循环，
 * 四个既有源（netease / kugou / qq / bodian）都是各自一个 hook + App.tsx 里挂一行。
 * 只注册 provider 不发水合，界面上就是空的。
 *
 * 与那四个源的唯一区别：Apple 没有登录动作。登录态由桥从用户自己的浏览器页面里读出来，
 * 所以这里只有「读当前是谁」，没有扫码、没有凭据落盘。
 */
export const useAppleLibrary = () => {
    const generation = useRef(0);
    const pendingSave = useRef<Promise<unknown>>(Promise.resolve());

    /** 解除本地绑定：清账户条目 + 清快照。不碰浏览器里的 Apple 会话。 */
    const detach = useCallback(async () => {
        useOnlineProviderAccountStore.getState().clearAccount(APPLE_PROVIDER_ID);
        await pendingSave.current.catch(() => {});
        await clearProviderAccountSnapshot(APPLE_PROVIDER_ID);
    }, []);

    const refresh = useCallback(async () => {
        const current = ++generation.current;
        const store = useOnlineProviderAccountStore.getState();
        try {
            // 用户主动登出过：启动时不再把账号自动认回来，否则「登出→重启→又登上了」。
            if (isAppleSessionSuppressed()) {
                await detach();
                return false;
            }
            // 浏览器没开、端口不对、或没有 music.apple.com 标签页 —— 桥不可用。
            // 这与「浏览器登录过期了」是两件事，所以走 availability 而不是当成未登录。
            if (!omni.getProviderAvailability(APPLE_PROVIDER_ID).configured) {
                await detach();
                return false;
            }
            store.updateAccount(APPLE_PROVIDER_ID, { freshness: 'refreshing', error: undefined });
            const user = await omni.getLoginStatus(APPLE_PROVIDER_ID);
            if (generation.current !== current) return false;
            if (!user) {
                await detach();
                return false;
            }
            // 换了一个 Apple ID 就不能沿用上一份快照：先清掉，再只恢复 id 相同的那一份。
            const visibleUser = useOnlineProviderAccountStore.getState().accounts[APPLE_PROVIDER_ID]?.user;
            if (!visibleUser || String(visibleUser.id) !== String(user.id)) {
                store.clearAccount(APPLE_PROVIDER_ID);
                const snapshot = await loadProviderAccountSnapshot(APPLE_PROVIDER_ID).catch(() => null);
                if (generation.current !== current) return false;
                const matching = snapshot && String(snapshot.user.id) === String(user.id) ? snapshot : null;
                store.updateAccount(APPLE_PROVIDER_ID, {
                    status: 'authenticated', user,
                    collections: matching?.collections || [], likedSongIds: [],
                    hydration: 'ready', freshness: 'refreshing',
                    lastUpdatedAt: matching?.savedAt, error: undefined,
                });
            }
            const collections = await getUserPlaylists(user.id);
            if (generation.current !== current) return false;
            const save = pendingSave.current.catch(() => {}).then(() => {
                if (generation.current !== current) return null;
                // 先落 store 再落盘：这中间若又有一次 refresh，旧的那次不会盖掉新的。
                store.updateAccount(APPLE_PROVIDER_ID, {
                    status: 'authenticated', user, collections,
                    likedSongIds: [], hydration: 'ready', error: undefined,
                });
                return saveProviderAccountSnapshot(APPLE_PROVIDER_ID, { user, collections, likedSongIds: [] });
            });
            pendingSave.current = save;
            const saved = await save;
            if (generation.current !== current) return false;
            if (!saved) return false;
            store.updateAccount(APPLE_PROVIDER_ID, { freshness: 'fresh', lastUpdatedAt: saved.savedAt });
            return true;
        } catch (error) {
            if (generation.current !== current) return false;
            // 令牌过期 / 浏览器里登出了：账户确实没了，清干净。
            if (error instanceof OnlineProviderError && error.code === 'auth-required') {
                await detach();
                return false;
            }
            // 其余失败（浏览器被关掉、Apple 网关抽风）不代表账户失效：
            // 已经有用户的就别把用户踢下线，只标记这次刷新失败。
            store.updateAccount(APPLE_PROVIDER_ID, {
                hydration: 'ready',
                freshness: 'error',
                status: useOnlineProviderAccountStore.getState().accounts[APPLE_PROVIDER_ID]?.user ? 'authenticated' : 'error',
                error: 'apple-refresh-failed',
            });
            return false;
        }
    }, [detach]);

    /**
     * 登出，分三档（L1/L2 必做，L3 由调用方确认后打开）：
     * - L1 本地缓存：IndexedDB 里按 provider 前缀删；
     * - L2 本地绑定 + 抑制标记：清账户、清快照，并阻止下次启动自动续登；
     * - L3 浏览器会话：经 CDP 清 music.apple.com 系源的存储（不动 Apple ID）。
     *
     * 为什么 L1/L2 不能等 L3：浏览器可能已经关掉、CDP 不通，
     * 那时本地那半边照样得清干净，否则界面上还会残留「已登录」。
     */
    const logout = useCallback(async (options?: { clearBrowserSession?: boolean }) => {
        generation.current++;
        suppressAppleSession();
        const purged = await Promise.all([omni.logout(APPLE_PROVIDER_ID), detach()]);
        const local = await purgeAppleLocalData().catch(() => ({ cacheEntries: 0, sessionKeys: 0 }));
        if (!options?.clearBrowserSession) {
            return { browserCleared: false, ...local, ok: true };
        }
        // 浏览器没开时 clearSession 会回 ok:true/cleared:false，不算失败。
        const browser = await clearAppleMusicBrowserSession().catch(() => ({ ok: false, cleared: false }));
        // 清完浏览器会话后本地再清一次：L3 期间可能又写回了快照。
        await purgeAppleLocalData().catch(() => ({ cacheEntries: 0, sessionKeys: 0 }));
        await Promise.all(purged).catch(() => {});
        return { browserCleared: Boolean(browser.ok && browser.cleared), ...local, ok: true };
    }, [detach]);

    useEffect(() => {
        // 先清掉上一次的账户元数据，再去问浏览器现在是谁：否则旧快照会冒充当前登录态显示出来。
        useOnlineProviderAccountStore.getState().clearAccount(APPLE_PROVIDER_ID);
        void refresh();
        return () => { generation.current++; };
    }, [refresh]);

    return { refresh, logout };
};
