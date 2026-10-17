import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { omni } from '../services/onlineMusic/omni';
import { clearAppleSessionSuppression } from '../services/onlineMusic/appleLocalData';
import { ensureAppleMusicBrowser, hideAppleMusicBrowser } from '../services/onlineMusic/appleBrowserSession';
import { OnlineProviderError } from '../types/onlineMusic';

// src/hooks/useAppleLoginGate.ts

const APPLE_PROVIDER_ID = 'apple';

/**
 * 启动时的 Apple 登录态校验。
 *
 * 规则（来自用户明确的流程约定）：
 * 1. **已登录** → 什么都不打扰，直接进正常使用；
 * 2. **未登录/异常** → 亮引导卡，让用户自己点「打开登录窗口」；
 * 3. 用户登录完 → **软复检**（不重启进程），通过就收起窗口；
 * 4. 复检仍失败 → 停在失败态，**不再自动重试**，把处置权交回用户。
 *
 * 刻意不做的事：不自动弹浏览器（会打断用户手上的事）、不代填任何凭据、
 * 不在复检失败后自己重试 —— 反复弹窗比报错更烦人。
 */
export type AppleGatePhase = 'idle' | 'checking' | 'guide' | 'waiting' | 'failed';

export interface AppleGateState {
    phase: AppleGatePhase;
    /** 引导卡是否应该显示。用户主动关掉后本次会话不再出现。 */
    visible: boolean;
    /** 拉起浏览器的失败原因（没装浏览器等），用于在卡片上给可执行的提示。 */
    browserError?: string;
    /** 复检失败的错误码，便于按类型给不同文案。 */
    failureCode?: string;
}

export interface AppleLoginGateOptions {
    /** 只有当前音源是 Apple 时才校验；其它音源不该被 Apple 的登录态打扰。 */
    enabled: boolean;
    /** 复检通过后触发一次曲库水合，避免用户还要手动刷新。 */
    onAuthenticated?: () => void;
}

export const useAppleLoginGate = ({ enabled, onAuthenticated }: AppleLoginGateOptions) => {
    const [state, setState] = useState<AppleGateState>({ phase: 'idle', visible: false });
    /** 用户这次会话里主动关过卡片就不再弹，避免每次刷新都追着问。 */
    const dismissedRef = useRef(false);

    const probe = useCallback(async (): Promise<'authenticated' | 'signed-out' | 'unavailable' | 'error'> => {
        if (!omni.getProviderAvailability(APPLE_PROVIDER_ID).configured) return 'unavailable';
        try {
            const user = await omni.getLoginStatus(APPLE_PROVIDER_ID);
            return user ? 'authenticated' : 'signed-out';
        } catch (error) {
            // 桥连不上（浏览器没开/端口不通）不等于未登录，但用户此刻确实用不了 Apple。
            if (error instanceof OnlineProviderError && error.code === 'auth-required') return 'signed-out';
            return 'error';
        }
    }, []);

    const check = useCallback(async () => {
        if (!enabled) return;
        // 登出过也要继续探测：L3 是「换账号」的入口，卡片是用户点进去登录的唯一按钮。
        // 抑制标记只挡「自动重新认证」（见 useAppleLibrary.refresh），不挡这张引导卡。
        // 真正的「别再问了」是本次会话内点过关闭（dismissedRef）。
        setState(previous => ({ ...previous, phase: 'checking' }));
        const result = await probe();
        if (result === 'authenticated') {
            setState({ phase: 'idle', visible: false });
            return;
        }
        if (dismissedRef.current) {
            setState({ phase: 'idle', visible: false });
            return;
        }
        setState({
            phase: 'guide',
            visible: true,
            failureCode: result === 'error' ? 'probe-failed' : undefined,
        });
    }, [enabled, probe]);

    /** 用户点了「打开登录窗口」：解除抑制，把专用浏览器弄到前台。 */
    const startLogin = useCallback(async () => {
        clearAppleSessionSuppression();
        setState({ phase: 'waiting', visible: true });
        const result = await ensureAppleMusicBrowser({ visible: true });
        if (!result.ok) {
            setState(previous => ({
                ...previous,
                phase: 'failed',
                visible: true,
                browserError: result.reason || 'browser-unavailable',
            }));
        }
    }, []);

    /** 「我登录好了」：软复检。通过就收起浏览器并触发水合，不通过就停在失败态。 */
    const recheck = useCallback(async () => {
        setState(previous => ({ ...previous, phase: 'checking' }));
        const result = await probe();
        if (result === 'authenticated') {
            // 复检通过就等于「用户重新登录了」：抑制标记必须清掉，否则随后的
            // refresh 仍会把它当成登出态，直接 detach、什么都不加载。
            clearAppleSessionSuppression();
            await hideAppleMusicBrowser();
            setState({ phase: 'idle', visible: false });
            onAuthenticated?.();
            return;
        }
        setState({
            phase: 'failed',
            visible: true,
            failureCode: result === 'unavailable' ? 'bridge-unavailable'
                : result === 'error' ? 'probe-failed'
                    : 'still-signed-out',
        });
    }, [onAuthenticated, probe]);

    /** 用户主动来登录（点了平台列表里的 Apple）：无条件把引导卡亮出来，不探测也不建扫码会话。 */
    const showGuide = useCallback(() => {
        dismissedRef.current = false;
        setState({ phase: 'guide', visible: true });
    }, []);

    /** 关掉引导卡，本次会话不再弹。不改变登录态，也不清任何数据。 */
    const dismiss = useCallback(() => {
        dismissedRef.current = true;
        setState({ phase: 'idle', visible: false });
    }, []);

    useEffect(() => {
        void check();
        // 只在「首次可用」时校验一次；enabled 从 false 变 true（用户切到 Apple）时再校验一次。
    }, [check]);

    const value = useMemo(() => ({ ...state, check, startLogin, recheck, dismiss, showGuide }), [check, dismiss, recheck, showGuide, startLogin, state]);

    return value;
};
