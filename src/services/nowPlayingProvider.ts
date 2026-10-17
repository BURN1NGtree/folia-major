import type {
    NowPlayingConnectionStatus,
    NowPlayingLyricPayload,
    NowPlayingQueueItem,
    NowPlayingQueueSnapshot,
    NowPlayingTrackSnapshot,
} from '../types';

export const NOW_PLAYING_WS_URL = 'ws://localhost:9863/api/ws/lyric';
const NOW_PLAYING_RECONNECT_DELAY_MS = 2000;

// Build the now-playing lyric WS URL from a host (e.g. 'localhost:9863'); lets the OBS web page pick the endpoint via a URL param.
export const buildNowPlayingWsUrl = (host: string): string => `ws://${host}/api/ws/lyric`;

type NowPlayingTrackMessage = {
    author?: string;
    title?: string;
    album?: string;
    cover?: string;
    duration?: number;
    id?: string | number;
    // 外部播放器的循环/随机档位（Apple 侧真实值），供双向同步回灌 Folia 的循环按钮。
    repeatMode?: number | null;
    shuffleMode?: number | null;
    // 外部播放器待播清单的曲目 id 顺序。Apple 一开随机就自己重排，靠它把 Folia 的列表拉齐。
    queueItemIds?: string[] | null;
    // 曲目的目录 id。Folia 用它判断「外部播放器自己换歌了」，再把标题/歌手/专辑/封面一起照过来。
    catalogId?: string | null;
};

/**
 * 桥的 Queue 事件：外部播放器待播清单的整份快照（只读）。
 * 只在队列真的变化时下发一次，不跟高频轮询跑。
 */
type NowPlayingQueueMessage = {
    position?: number;
    items?: Array<{
        id?: string | null;
        title?: string | null;
        artist?: string | null;
        album?: string | null;
        cover?: string | null;
        durationMs?: number | null;
    }>;
};

type NowPlayingPlayerStateMessage = {
    hasSong?: boolean;
    isPaused?: boolean;
    seekbarCurrentPosition?: number;
    statePercent?: number;
};

type NowPlayingLyricMessage = {
    source?: string;
    title?: string;
    author?: string;
    duration?: number;
    hasLyric?: boolean;
    hasTranslatedLyric?: boolean;
    hasKaraokeLyric?: boolean;
    lrc?: string;
    translatedLyric?: string;
    karaokeLyric?: string;
};

type NowPlayingWsEnvelope = {
    event?: string;
    data?: unknown;
};

export type NowPlayingProgressUpdate = {
    progressMs: number;
    isReplay: boolean;
    quality: 'precise' | 'coarse';
};

export type NowPlayingProviderSnapshot = {
    connectionStatus: NowPlayingConnectionStatus;
    track: NowPlayingTrackSnapshot | null;
    lyric: NowPlayingLyricPayload | null;
    isPaused: boolean;
    progressMs: number;
};

/** 两条 Track 的待播清单顺序是否一致；缺省与空数组等价（都没给 = 都不动顺序）。 */
const areQueueIdsEqual = (left?: string[] | null, right?: string[] | null) => {
    const a = Array.isArray(left) ? left : [];
    const b = Array.isArray(right) ? right : [];
    return a.length === b.length && a.every((value, index) => value === b[index]);
};

const areTracksEqual = (
    left: NowPlayingTrackSnapshot | null,
    right: NowPlayingTrackSnapshot | null,
) => (
    left?.id === right?.id
    && left?.title === right?.title
    && left?.artist === right?.artist
    && left?.album === right?.album
    && left?.coverUrl === right?.coverUrl
    && left?.durationMs === right?.durationMs
    // 循环/随机档位也算“曲目变了”。桥在档位变化时只发一条字段全同、仅这两个值不同的
    // Track 消息，漏比它们就会被上面的去重整条丢掉，Folia 永远看不到外部改了档位。
    && (left?.repeatMode ?? null) === (right?.repeatMode ?? null)
    && (left?.shuffleMode ?? null) === (right?.shuffleMode ?? null)
    // 队列顺序同理：随机一拨，桥会单发一条只有顺序变了的 Track，漏比就永远拉不齐两边列表。
    && areQueueIdsEqual(left?.queueItemIds, right?.queueItemIds)
);

const areLyricsEqual = (
    left: NowPlayingLyricPayload | null,
    right: NowPlayingLyricPayload | null,
) => (
    left?.source === right?.source
    && left?.title === right?.title
    && left?.artist === right?.artist
    && left?.durationMs === right?.durationMs
    && left?.hasLyric === right?.hasLyric
    && left?.hasTranslatedLyric === right?.hasTranslatedLyric
    && left?.hasKaraokeLyric === right?.hasKaraokeLyric
    && left?.lrc === right?.lrc
    && left?.translatedLyric === right?.translatedLyric
    && left?.karaokeLyric === right?.karaokeLyric
);

const decodeXmlEntities = (value: string): string => {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&#10;|&#x0A;/gi, '\n')
        .replace(/&#13;|&#x0D;/gi, '\r');
};

const extractQrcLyricContent = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed.startsWith('<?xml') && !trimmed.includes('<Lyric_')) {
        return value;
    }

    const contentMatch = trimmed.match(/LyricContent="([\s\S]*?)"\s*\/?>/i);
    if (!contentMatch?.[1]) {
        return value;
    }

    return decodeXmlEntities(contentMatch[1]).replace(/\r\n/g, '\n');
};

type NowPlayingProviderCallbacks = {
    debug?: boolean;
    onConnectionStatusChange?: (status: NowPlayingConnectionStatus) => void;
    onTrack?: (track: NowPlayingTrackSnapshot | null) => void;
    onLyric?: (lyric: NowPlayingLyricPayload | null) => void;
    onPauseState?: (isPaused: boolean) => void;
    onProgress?: (update: NowPlayingProgressUpdate) => void;
    /** 外部播放器的待播清单快照；null 表示对方明确没有队列。 */
    onQueue?: (queue: NowPlayingQueueSnapshot | null) => void;
};

const clampProgressMs = (value: unknown): number => {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
        return 0;
    }

    return Math.max(0, Math.floor(numericValue));
};

const normalizeDurationMs = (value: unknown): number => {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
        return 0;
    }

    const safeValue = Math.max(0, numericValue);

    // now-playing returns track/lyric duration in seconds (for example 170),
    // while progress fields arrive in milliseconds.
    if (safeValue > 0 && safeValue < 10_000) {
        return Math.floor(safeValue * 1000);
    }

    return Math.floor(safeValue);
};

const resolveSnapshotDurationMs = (snapshot: NowPlayingProviderSnapshot): number => {
    return snapshot.track?.durationMs || snapshot.lyric?.durationMs || 0;
};

const normalizePauseStateProgressMs = (
    value: unknown,
    snapshot: NowPlayingProviderSnapshot,
    statePercent?: unknown
): number => {
    const numericValue = typeof value === 'number' ? value : Number(value);
    const numericPercent = typeof statePercent === 'number' ? statePercent : Number(statePercent);
    const durationMs = resolveSnapshotDurationMs(snapshot);

    if (!Number.isFinite(numericValue)) {
        if (Number.isFinite(numericPercent) && durationMs > 0) {
            return Math.max(0, Math.min(durationMs, Math.floor(durationMs * numericPercent)));
        }
        return 0;
    }

    const safeValue = Math.max(0, numericValue);

    if (durationMs > 0) {
        const durationSeconds = durationMs / 1000;
        if (safeValue <= durationSeconds + 1) {
            return Math.min(durationMs, Math.floor(safeValue * 1000));
        }
    }

    return Math.floor(safeValue);
};

/**
 * 把桥的 Queue 事件折成待播清单快照。
 *
 * 一行要不要留：只要求有标题。id 可以缺（本地曲目没有目录 id），缺了置 null，
 * 由上层判断「这一行不是外部曲目」。
 */
export const normalizeNowPlayingQueue = (raw: unknown): NowPlayingQueueSnapshot | null => {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const message = raw as NowPlayingQueueMessage;
    const list = Array.isArray(message.items) ? message.items : [];
    const items: NowPlayingQueueItem[] = [];

    for (const entry of list) {
        const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
        if (!title) {
            continue;
        }
        items.push({
            id: entry?.id == null ? null : String(entry.id),
            title,
            artist: typeof entry?.artist === 'string' ? entry.artist : '',
            album: typeof entry?.album === 'string' ? entry.album : '',
            coverUrl: typeof entry?.cover === 'string' && entry.cover ? entry.cover : null,
            durationMs: typeof entry?.durationMs === 'number' && Number.isFinite(entry.durationMs)
                ? entry.durationMs
                : null,
        });
    }

    if (!items.length) {
        return null;
    }

    return {
        position: typeof message.position === 'number' && Number.isFinite(message.position) ? message.position : -1,
        items,
    };
};

export const normalizeNowPlayingTrack = (raw: unknown): NowPlayingTrackSnapshot | null => {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const track = raw as NowPlayingTrackMessage;
    const title = typeof track.title === 'string' ? track.title.trim() : '';
    const artist = typeof track.author === 'string' ? track.author.trim() : '';
    const album = typeof track.album === 'string' ? track.album.trim() : '';
    const coverUrl = typeof track.cover === 'string' ? track.cover.trim() : '';
    const durationMs = normalizeDurationMs(track.duration);
    const idValue = track.id;
    const id = idValue === undefined || idValue === null ? null : String(idValue);

    if (!title && !artist && !album && !coverUrl && durationMs === 0 && !id) {
        return null;
    }

    return {
        id,
        title: title || 'Now Playing',
        artist: artist || 'Now Playing',
        album: album || '',
        coverUrl: coverUrl || null,
        durationMs: durationMs || null,
        repeatMode: typeof track.repeatMode === 'number' ? track.repeatMode : null,
        shuffleMode: typeof track.shuffleMode === 'number' ? track.shuffleMode : null,
        queueItemIds: Array.isArray(track.queueItemIds)
            ? track.queueItemIds.map((value) => String(value)).filter(Boolean)
            : null,
        catalogId: typeof track.catalogId === 'string' && track.catalogId ? track.catalogId : null,
    };
};

export const normalizeNowPlayingLyricPayload = (raw: unknown): NowPlayingLyricPayload | null => {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const lyric = raw as NowPlayingLyricMessage;
    const lrc = typeof lyric.lrc === 'string' ? lyric.lrc : '';
    const translatedLyric = typeof lyric.translatedLyric === 'string' ? lyric.translatedLyric : '';
    const karaokeLyric = typeof lyric.karaokeLyric === 'string'
        ? extractQrcLyricContent(lyric.karaokeLyric)
        : '';
    const hasUsableLyric = Boolean(lrc.trim() || translatedLyric.trim() || karaokeLyric.trim());

    if (!hasUsableLyric && !lyric.hasLyric && !lyric.hasKaraokeLyric) {
        return null;
    }

    return {
        source: typeof lyric.source === 'string' ? lyric.source.trim().toLowerCase() : null,
        title: typeof lyric.title === 'string' ? lyric.title.trim() : '',
        artist: typeof lyric.author === 'string' ? lyric.author.trim() : '',
        durationMs: normalizeDurationMs(lyric.duration) || null,
        hasLyric: Boolean(lyric.hasLyric || lrc.trim()),
        hasTranslatedLyric: Boolean(lyric.hasTranslatedLyric || translatedLyric.trim()),
        hasKaraokeLyric: Boolean(lyric.hasKaraokeLyric || karaokeLyric.trim()),
        lrc: lrc || null,
        translatedLyric: translatedLyric || null,
        karaokeLyric: karaokeLyric || null,
    };
};

export class NowPlayingProvider {
    private readonly callbacks: NowPlayingProviderCallbacks;
    private readonly debug: boolean;
    private readonly wsUrl: string;
    private socket: WebSocket | null = null;
    private reconnectTimer: number | null = null;
    private stopped = true;
    private lastPreciseProgressMs = 0;
    private lastPreciseProgressAtMs = 0;
    private snapshot: NowPlayingProviderSnapshot = {
        connectionStatus: 'disabled',
        track: null,
        lyric: null,
        isPaused: true,
        progressMs: 0,
    };

    constructor(callbacks: NowPlayingProviderCallbacks = {}, options: { wsUrl?: string } = {}) {
        this.callbacks = callbacks;
        this.debug = callbacks.debug === true;
        this.wsUrl = options.wsUrl ?? NOW_PLAYING_WS_URL;
    }

    getSnapshot(): NowPlayingProviderSnapshot {
        return this.snapshot;
    }

    start() {
        this.stopped = false;
        this.clearReconnectTimer();
        this.openSocket();
    }

    stop({ reset = true }: { reset?: boolean } = {}) {
        this.stopped = true;
        this.clearReconnectTimer();

        if (this.socket) {
            this.socket.onopen = null;
            this.socket.onclose = null;
            this.socket.onerror = null;
            this.socket.onmessage = null;
            this.socket.close();
            this.socket = null;
        }

        if (reset) {
            this.snapshot = {
                connectionStatus: 'disabled',
                track: null,
                lyric: null,
                isPaused: true,
                progressMs: 0,
            };
            this.lastPreciseProgressMs = 0;
            this.lastPreciseProgressAtMs = 0;
            this.callbacks.onTrack?.(null);
            this.callbacks.onLyric?.(null);
            this.callbacks.onQueue?.(null);
            this.callbacks.onPauseState?.(true);
            this.callbacks.onProgress?.({ progressMs: 0, isReplay: true, quality: 'precise' });
            this.callbacks.onConnectionStatusChange?.('disabled');
        }
    }

    private openSocket() {
        if (this.stopped || this.socket) {
            return;
        }

        this.updateConnectionStatus('connecting');
        const socket = new WebSocket(this.wsUrl);
        this.socket = socket;

        socket.onopen = () => {
            this.updateConnectionStatus('connected');
        };

        socket.onmessage = (event) => {
            this.handleMessage(event.data);
        };

        socket.onerror = () => {
            this.updateConnectionStatus('error');
        };

        socket.onclose = () => {
            this.socket = null;
            if (this.stopped) {
                return;
            }

            this.updateConnectionStatus('error');
            this.scheduleReconnect();
        };
    }

    private handleMessage(rawData: unknown) {
        if (typeof rawData !== 'string') {
            if (this.debug) {
                console.log('[NowPlaying][ws] Received non-string payload:', rawData);
            }
            return;
        }

        let payload: NowPlayingWsEnvelope;
        try {
            payload = JSON.parse(rawData) as NowPlayingWsEnvelope;
        } catch (error) {
            console.warn('[NowPlaying] Failed to parse websocket payload', error);
            if (this.debug) {
                console.log('[NowPlaying][ws] Raw payload text:', rawData);
            }
            return;
        }

        if (this.debug) {
            console.log('[NowPlaying][ws] Incoming event:', payload.event, payload.data);
        }

        switch (payload.event) {
            case 'Track': {
                const track = normalizeNowPlayingTrack(payload.data);
                if (this.debug) {
                    console.log('[NowPlaying][ws] Normalized track:', track);
                }
                if (areTracksEqual(this.snapshot.track, track)) {
                    break;
                }
                this.snapshot = {
                    ...this.snapshot,
                    track,
                };
                if (track) {
                    this.callbacks.onTrack?.(track);
                }
                break;
            }
            case 'Queue': {
                const queue = normalizeNowPlayingQueue(payload.data);
                if (this.debug) {
                    console.log('[NowPlaying][ws] Normalized queue:', queue ? (queue.items.length + ' 首 @ ' + queue.position) : null);
                }
                this.callbacks.onQueue?.(queue);
                break;
            }
            case 'Lyric': {
                const lyric = normalizeNowPlayingLyricPayload(payload.data);
                if (this.debug) {
                    console.log('[NowPlaying][ws] Normalized lyric payload:', lyric);
                }
                if (areLyricsEqual(this.snapshot.lyric, lyric)) {
                    break;
                }
                this.snapshot = {
                    ...this.snapshot,
                    lyric,
                };
                this.callbacks.onLyric?.(lyric);
                break;
            }
            case 'PlayerPauseState': {
                const playerState = (payload.data && typeof payload.data === 'object')
                    ? payload.data as NowPlayingPlayerStateMessage
                    : null;
                const isPaused = Boolean(playerState?.isPaused);
                const coarseProgressMs = normalizePauseStateProgressMs(
                    playerState?.seekbarCurrentPosition,
                    this.snapshot,
                    playerState?.statePercent,
                );
                const hasRecentPreciseProgress = Date.now() - this.lastPreciseProgressAtMs <= 5_000;
                const progressMs = hasRecentPreciseProgress
                    ? this.lastPreciseProgressMs
                    : coarseProgressMs;
                if (this.debug) {
                    console.log('[NowPlaying][ws] Pause state update:', {
                        raw: playerState,
                        isPaused,
                        coarseProgressMs,
                        usedRecentPreciseProgress: hasRecentPreciseProgress,
                        progressMs,
                    });
                }
                this.snapshot = {
                    ...this.snapshot,
                    isPaused,
                    progressMs,
                };
                this.callbacks.onPauseState?.(isPaused);
                this.callbacks.onProgress?.({
                    progressMs,
                    isReplay: false,
                    quality: hasRecentPreciseProgress ? 'precise' : 'coarse',
                });
                break;
            }
            case 'PlayerProgress': {
                const data = payload.data as { progress?: number } | undefined;
                const progressMs = clampProgressMs(data?.progress);
                this.lastPreciseProgressMs = progressMs;
                this.lastPreciseProgressAtMs = Date.now();
                if (this.debug) {
                    console.log('[NowPlaying][ws] Progress update:', {
                        raw: data,
                        progressMs,
                    });
                }
                this.snapshot = {
                    ...this.snapshot,
                    progressMs,
                };
                this.callbacks.onProgress?.({ progressMs, isReplay: false, quality: 'precise' });
                break;
            }
            case 'PlayerProgressReplay': {
                if (this.debug) {
                    console.log('[NowPlaying][ws] Replay progress reset');
                }
                this.lastPreciseProgressMs = 0;
                this.lastPreciseProgressAtMs = Date.now();
                this.snapshot = {
                    ...this.snapshot,
                    progressMs: 0,
                };
                this.callbacks.onProgress?.({ progressMs: 0, isReplay: true, quality: 'precise' });
                break;
            }
            default:
                if (this.debug) {
                    console.log('[NowPlaying][ws] Unhandled event:', payload.event, payload.data);
                }
                break;
        }
    }

    private scheduleReconnect() {
        this.clearReconnectTimer();
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, NOW_PLAYING_RECONNECT_DELAY_MS);
    }

    private clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private updateConnectionStatus(status: NowPlayingConnectionStatus) {
        if (this.debug) {
            console.log('[NowPlaying][ws] Connection status:', status);
        }
        this.snapshot = {
            ...this.snapshot,
            connectionStatus: status,
        };
        this.callbacks.onConnectionStatusChange?.(status);
    }
}
