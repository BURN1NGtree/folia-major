import { getCacheKeysByPrefix, removeCacheEntries } from '../db';
import { getProviderCacheKey, getProviderSessionKey } from './providerStorage';

// src/services/onlineMusic/appleLocalData.ts

/**
 * Apple 账号留在本机的**本地痕迹**：缓存行、会话键、以及「别自动续登」的抑制标记。
 *
 * 为什么单独一层：登出要删的东西分散在 IndexedDB 缓存和 localStorage 两处，
 * 散着删必然会漏（实测漏掉的就是 `user_home_snapshot` 这类快照缓存）。
 * 这里把「Apple 的本地痕迹」定义成**按命名空间前缀**的一组键，删除逻辑只认前缀。
 */

/**
 * 抑制标记：本机已登出，别再在启动时自动重新探测登录态。
 *
 * 少了它会出现「登出→重启→自己又登回来了」的假登出：只要浏览器里还有会话，
 * 启动探测就会把账号重新认回来。这个标记只在用户**主动重新登录**时清掉。
 */
const APPLE_SESSION_SUPPRESSED_KEY = 'folia.apple.session-suppressed';

const isBrowser = () => typeof localStorage !== 'undefined';

/** 是否处于「用户主动登出过」的状态。 */
export const isAppleSessionSuppressed = (): boolean => {
    if (!isBrowser()) return false;
    try {
        return localStorage.getItem(APPLE_SESSION_SUPPRESSED_KEY) === '1';
    } catch {
        return false;
    }
};

/** 用户登出后调用：此后启动不再自动把账号认回来。 */
export const suppressAppleSession = (): void => {
    if (!isBrowser()) return;
    try {
        localStorage.setItem(APPLE_SESSION_SUPPRESSED_KEY, '1');
    } catch {
        // 存不下不影响本次登出，最坏下次启动再探一次。
    }
};

/** 用户主动发起登录时调用：解除抑制，允许探测把会话认回来。 */
export const clearAppleSessionSuppression = (): void => {
    if (!isBrowser()) return;
    try {
        localStorage.removeItem(APPLE_SESSION_SUPPRESSED_KEY);
    } catch {
        // 同上。
    }
};

export interface AppleLocalPurgeResult {
    /** 删掉的缓存行数（IndexedDB 侧）。 */
    cacheEntries: number;
    /** 删掉的 localStorage 键数量。 */
    sessionKeys: number;
}

/**
 * 清掉 Apple 在本机的全部痕迹（L1+L2）。
 *
 * 只认 `online_provider_apple_` / `online_provider:apple:` 两个前缀 ——
 * 换 provider 时其它源的数据必须纹丝不动。
 *
 * 注意：这**不**登出浏览器会话（那是 L3，见 `appleBrowserSession.ts`）。
 * 分批做是为了让「本地清干净」这件事在浏览器关着、CDP 不通时也能成功。
 */
export async function purgeAppleLocalData(): Promise<AppleLocalPurgeResult> {
    const cachePrefix = getProviderCacheKey('apple', '');
    const sessionPrefix = getProviderSessionKey('apple', '');

    // 先取键再删：既拿到条数（给调用方判断「到底有没有东西被清掉」），
    // 也避免按前缀直删时把别的源的键带进去。
    const doomedCacheKeys = await getCacheKeysByPrefix([cachePrefix]);
    await removeCacheEntries(doomedCacheKeys);
    const cacheEntries = doomedCacheKeys.length;

    let sessionKeys = 0;
    if (isBrowser()) {
        try {
            const doomed: string[] = [];
            for (let index = 0; index < localStorage.length; index += 1) {
                const key = localStorage.key(index);
                if (key && key.startsWith(sessionPrefix)) doomed.push(key);
            }
            doomed.forEach(key => localStorage.removeItem(key));
            sessionKeys = doomed.length;
        } catch {
            // localStorage 不可写时只损失会话键，缓存仍然删掉了。
        }
    }

    return { cacheEntries, sessionKeys };
}
