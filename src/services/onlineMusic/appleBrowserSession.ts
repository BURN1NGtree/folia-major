import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/appleBrowserSession.ts

/**
 * 渲染层访问「Apple Music 专用浏览器」的唯一入口。
 *
 * 只做三件事：把浏览器弄出来给用户登录、登录完成后收起来、登出时清掉它的会话。
 * **不碰凭据**：账号密码与双重认证验证码全部由用户在浏览器里自己输入，这里不读、不传、不存。
 */

export interface AppleBrowserResult {
    ok: boolean;
    reason?: string;
    detail?: string;
    spawned?: boolean;
    reused?: boolean;
    cleared?: boolean;
}

export interface AppleBrowserBridge {
    status?: () => Promise<unknown>;
    probe?: () => Promise<{ ok?: boolean; ready?: boolean }>;
    ensure: (options?: { visible?: boolean }) => Promise<AppleBrowserResult>;
    hide: () => Promise<AppleBrowserResult>;
    clearSession: () => Promise<AppleBrowserResult>;
}

const getBridge = (): AppleBrowserBridge | null => {
    if (typeof window === 'undefined') return null;
    const bridge = (window.electron as { appleMusicBrowser?: AppleBrowserBridge } | undefined)?.appleMusicBrowser;
    return bridge && typeof bridge.ensure === 'function' ? bridge : null;
};

/** 网页版 / 老版本桌面端没有这段 IPC，调用方据此降级到「手动打开浏览器」。 */
export const isAppleBrowserBridgeAvailable = (): boolean => getBridge() != null;

const requireBridge = (action: string): AppleBrowserBridge => {
    const bridge = getBridge();
    if (!bridge) {
        throw new OnlineProviderError('unavailable', `Apple Music browser ${action} requires the desktop app`,
            'apple', undefined, undefined, undefined, { stage: 'runtime', transient: false });
    }
    return bridge;
};

/** 拉起（或复用）专用浏览器并让它可交互。失败不抛错，由界面决定是否降级成手抄指引。 */
export async function ensureAppleMusicBrowser(options?: { visible?: boolean }): Promise<AppleBrowserResult> {
    const bridge = getBridge();
    if (!bridge) return { ok: false, reason: 'bridge-unavailable' };
    try {
        const result = await bridge.ensure(options);
        return result && typeof result === 'object' ? result : { ok: false, reason: 'invalid-response' };
    } catch (error) {
        return { ok: false, reason: 'ipc-failed', detail: (error as Error)?.message };
    }
}

/** 用户登录完成后收起窗口。收不起来不是错误，只是体验降级。 */
export async function hideAppleMusicBrowser(): Promise<AppleBrowserResult> {
    const bridge = getBridge();
    if (!bridge) return { ok: false, reason: 'bridge-unavailable' };
    try {
        return await bridge.hide();
    } catch (error) {
        return { ok: false, reason: 'ipc-failed', detail: (error as Error)?.message };
    }
}

/**
 * 登出最后一档：清掉专用浏览器里 `music.apple.com` 系的存储。
 *
 * 只退 Apple Music，不动 Apple ID —— 用户其它苹果服务不受影响。
 */
export async function clearAppleMusicBrowserSession(): Promise<AppleBrowserResult> {
    const bridge = requireBridge('session clear');
    try {
        return await bridge.clearSession();
    } catch (error) {
        return { ok: false, reason: 'ipc-failed', detail: (error as Error)?.message };
    }
}
