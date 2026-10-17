import { OnlineProviderError } from '../../types/onlineMusic';
import type { ProviderErrorCode } from '../../types/onlineMusic';

// src/services/onlineMusic/appleTransport.ts

/**
 * 渲染进程 → 主进程（`electron/appleMusicBridge.cjs`）的唯一通道。
 *
 * 与 Bodian / KuGou 的 transport 同一套路：可用性探测、参数边界、错误码翻译。
 * 差别在于**归一化不在这里**——Apple 的响应形状（`data[]` + `attributes`）由
 * `appleNormalize.ts` 处理，transport 只负责搬运与报错。
 *
 * 两条与实测绑定的约定：
 * 1. **只读。** 下面这份操作名必须与主进程白名单逐字一致；`appleTransport.test.ts`
 *    会直接读桥的 `APPLE_OPERATIONS` 做漂移比对，改一边而忘另一边会立刻失败。
 * 2. **分页上限 100。** 与 Bodian 不同，Apple 的截断在桥里就做掉了（`clampLimit`），
 *    所以这里不再重复压 limit，避免两处各有一套上限。
 */

export const APPLE_OPERATIONS = [
    'session',
    'ping',
    'library_playlists',
    'library_playlist_detail',
    'library_playlist_tracks',
    'library_songs',
    'library_albums',
    'library_album_detail',
    'library_album_tracks',
    'library_artists',
    'recent_played',
    'me_recommendations',
    'catalog_search',
    'catalog_song',
    'catalog_album',
    'catalog_artist',
    'catalog_playlist',
    'catalog_playlist_tracks',
    'song_lyrics',
] as const;

export type AppleOperation = (typeof APPLE_OPERATIONS)[number];

/** 交给主进程的参数。具体形状由操作决定，桥侧负责校验并拒绝非法值。 */
export type AppleParams = Record<string, unknown>;

/** 桥的信封。成功带 `data`，失败带 `error{code,message,httpStatus,detail,reason}`。 */
export interface AppleBridgeResult {
    ok: boolean;
    data?: unknown;
    error?: {
        code?: string;
        message?: string;
        httpStatus?: number;
        /** 连接层失败的原因（例如 `no-apple-target`）。 */
        reason?: string;
        /** 本地异常文本。 */
        detail?: string;
        /** 上游非 JSON 响应体的前若干字符，用于诊断 403 的 HTML 错误页。 */
        text?: string;
    };
}

export const getAppleTransportAvailability = () => (
    typeof window !== 'undefined' && typeof window.electron?.appleMusicRequest === 'function'
        ? { configured: true } as const
        : { configured: false, reason: 'runtime-unavailable' } as const
);

/**
 * 桥只会吐出这几个码（见 `appleMusicBridge.cjs` 的 `toEnvelope`）。
 * 用白名单而不是 `as` 强转：桥将来新增码时，这里会落到 `invalid-response` 并在
 * 冒烟脚本里露出来，而不是把一个没见过的码透传给 UI。
 */
const APPLE_ERROR_CODES: readonly ProviderErrorCode[] = [
    'auth-required',
    'unsupported',
    'rate-limited',
    'service-unavailable',
    'network',
    'invalid-response',
    'unavailable',
];

const isProviderErrorCode = (value: unknown): value is ProviderErrorCode =>
    typeof value === 'string' && (APPLE_ERROR_CODES as readonly string[]).includes(value);

/**
 * 桥的错误 → `OnlineProviderError`。
 *
 * 刻意**不**填 `retryAfterMs`：桥目前没读 Apple 的 `Retry-After`（页面侧 CORS 是否会
 * 暴露该响应头也未经实测），编造退避时长比不填更坏。
 *
 * `reason`（连接层细分，例如 `no-apple-target`）不是上游 code，所以不塞进 `upstreamCode`，
 * 而是并入 message —— 否则这类最有诊断价值的信息会整条丢掉。
 */
export function toAppleProviderError(error: AppleBridgeResult['error']): OnlineProviderError {
    const code = isProviderErrorCode(error?.code) ? error.code : 'invalid-response';
    const base = error?.message || `Apple Music request failed (${error?.code ?? 'unknown'})`;
    const message = error?.reason && !base.includes(error.reason) ? `${base} [${error.reason}]` : base;
    return new OnlineProviderError(code, message, 'apple', undefined, error?.httpStatus,
        undefined, { stage: 'transport', upstreamCode: error?.code ?? error?.reason });
}

export async function requestApple<T = unknown>(operation: AppleOperation, params: AppleParams = {}): Promise<T> {
    if (!getAppleTransportAvailability().configured) {
        // 网页版没有桌面桥：重试不会变好，transient:false 让界面显示「需要桌面版」而不是「稍后再试」。
        throw new OnlineProviderError('unavailable', 'Apple Music requires the desktop app', 'apple',
            undefined, undefined, undefined, { stage: 'runtime', transient: false });
    }
    let result: AppleBridgeResult;
    try {
        result = await window.electron!.appleMusicRequest(operation, params);
    }
    // IPC 被拒是本地桌面进程的故障，不是网络故障。
    catch (error) {
        throw new OnlineProviderError('unavailable', 'Apple Music desktop request failed', 'apple',
            error, undefined, undefined, { stage: 'ipc' });
    }
    if (!result || typeof result !== 'object') {
        throw new OnlineProviderError('invalid-response', 'Apple Music bridge returned no envelope', 'apple',
            undefined, undefined, undefined, { stage: 'ipc' });
    }
    if (!result.ok) throw toAppleProviderError(result.error);
    return result.data as T;
}
