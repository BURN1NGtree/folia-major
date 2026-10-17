// src/services/nowPlayingControl.ts

/**
 * now-playing 节目的播控通道（方向 2a）。
 *
 * 与取数（`utils/nowPlayingClock.ts` 的进度查询）打同一个 9863 服务，但方向相反：
 * 这里是 Folia 把播控命令**发出去**，由外部播放器执行。节目本身不认识播放器，
 * 所以「命令是否真的生效」由服务端回读真实播放状态后回答（`applied`），
 * 不是「发出即成功」—— 冻结页面里的命令 promise 会一直挂着，直到页面被解冻才回放。
 *
 * @note 地址与 Now Playing 舞台源同一约定，固定回环地址；换机由 OBS 场景的 host 参数负责，
 *       桌面舞台不暴露该开关。
 */

export const NOW_PLAYING_CONTROL_URL = 'http://localhost:9863/api/control';

export type NowPlayingControlCommand =
    | 'play' | 'pause' | 'toggle' | 'next' | 'previous' | 'seek' | 'playSong'
    /** 循环 / 随机是外部播放器的**状态**，不是一次性动作；这两个命令改它的模式。 */
    | 'setRepeatMode' | 'setShuffleMode'
    /** 在对方那边开一条电台（Apple 的『XX 的电台』『探索电台』）：参数借 catalogId 传 station id。 */
    | 'playStation'
    /** 跳到待播清单的第 N 行；只挪播放位置，不重建队列。 */
    | 'jumpToIndex';

/** 循环模式在两边叫法不同：Folia 用 off/all/one，MusicKit 用 none/one/all。 */
export type NowPlayingRepeatMode = 'none' | 'one' | 'all';
export type NowPlayingShuffleMode = 'off' | 'songs';

export type NowPlayingControlResult = {
    ok: boolean;
    command: NowPlayingControlCommand;
    /** 命令是否已被外部播放器执行（服务端回读状态判定，而不是它的返回值）。 */
    applied: boolean;
    error?: string;
};

export type NowPlayingControlOptions = {
    signal?: AbortSignal;
    /** playSong 要点名播哪一首。 */
    catalogId?: string;
    /**
     * playSong 同时给出**整条队列**（队列统一方向）。外部播放器会按这个顺序建队列，
     * 于是它的待播列表和 Folia 看到的一致，上一首/下一首才有地方去。
     * 只给 catalogId 时对方只能建单首队列，切歌键就废了。
     */
    ids?: string[];
    /** setRepeatMode / setShuffleMode 的目标档位。 */
    mode?: NowPlayingRepeatMode | NowPlayingShuffleMode;
    /** jumpToIndex 的目标行号（0 基，外部播放器待播清单里的位置）。 */
    index?: number;
};

/**
 * 发一条播控命令。永不抛错：网络失败也被折成 `{ ok: false, error }`，
 * 调用方只需要看 `applied` 决定要不要提示。
 */
export const sendNowPlayingControl = async (
    command: NowPlayingControlCommand,
    positionMs?: number,
    options: NowPlayingControlOptions = {}
): Promise<NowPlayingControlResult> => {
    try {
        const response = await fetch(NOW_PLAYING_CONTROL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                command,
                ...(typeof positionMs === 'number' ? { positionMs } : {}),
                // playSong 要点名播哪一首：Folia 里没有可播的流（DRM），只能让 Apple Music 去播。
                ...(options.catalogId ? { catalogId: options.catalogId } : {}),
                ...(options.ids?.length ? { ids: options.ids } : {}),
                ...(options.mode ? { mode: options.mode } : {}),
                ...(typeof options.index === 'number' ? { index: options.index } : {}),
            }),
            signal: options.signal,
        });
        const payload = await response.json() as { ok?: unknown; applied?: unknown; error?: unknown };
        return {
            ok: payload?.ok === true,
            command,
            applied: payload?.applied === true,
            error: typeof payload?.error === 'string' ? payload.error : undefined,
        };
    } catch (error) {
        return {
            ok: false,
            command,
            applied: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
};
