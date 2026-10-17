import type { SongResult } from '../../types';

/**
 * 当前曲目若是 Apple Music 的，取它的目录 id。
 *
 * 用途：Folia 拿不到 Apple 的音频流（DRM），所以对 Apple 曲目按「播放」只能是让
 * Apple Music 去播这一首（`playSong` 命令）。库内曲目（`l.`/`i.` 前缀）没有可播 id 时
 * 会退到纯数字的 mediaId，两者都拿不到就返回 undefined（调用方继续走本地播放）。
 */
export const resolveAppleCatalogId = (
    song: { sourceRef?: { kind: string; providerId?: string; mediaId: string; providerData?: Record<string, unknown> } } | null | undefined
): string | undefined => {
    const ref = song?.sourceRef;
    if (!ref || ref.kind !== 'online' || ref.providerId !== 'apple') return undefined;
    const fromData = ref.providerData?.catalogId;
    if (typeof fromData === 'string' && fromData) return fromData;
    return /^\d+$/.test(ref.mediaId) ? ref.mediaId : undefined;
};

/**
 * 这首歌是否该交给外部播放器，而不是 Folia 自己的播放链路。
 *
 * 判据是「Folia 拿不到可播的流」：Apple Music 曲目即属此类，provider 的 `capabilities.playback`
 * 为 false，`omni.canPlaySong` 也返回 false。命中时播放动作转发给桥，界面状态由镜像 effect 跟随。
 */
export const shouldPlayExternally = (
    song: SongResult | null | undefined,
    canPlay: boolean,
): boolean => Boolean(resolveAppleCatalogId(song as never)) && !canPlay;

/** Folia 的循环档位，映射成外部播放器（MusicKit）的枚举名。 */
export const mapFoliaLoopToExternal = (loopMode: 'off' | 'all' | 'one'): 'none' | 'one' | 'all' =>
    (loopMode === 'off' ? 'none' : loopMode);

/**
 * 外部播放器回读的循环档位，映射回 Folia 的档位。
 *
 * 桥送来的 `repeatMode` 是 MusicKit 的枚举**数值**（`PlayerRepeatMode{none:0, one:1, all:2}`）；
 * 认不出来（缺字段、未知值）时返回 null，调用方就别动界面——乱猜比不猜更糟。
 */
export const mapExternalLoopToFolia = (repeatMode: unknown): 'off' | 'all' | 'one' | null => {
    if (repeatMode === null || repeatMode === undefined || repeatMode === '') return null;
    const value = Number(repeatMode);
    if (!Number.isFinite(value)) return null;
    if (value === 0) return 'off';
    if (value === 1) return 'one';
    if (value === 2) return 'all';
    return null;
};

/**
 * 把外部播放器当前的曲目，重建成 Folia 能用的 `SongResult`。
 *
 * 用途：Apple 自己往下走（自动切歌，或用户在 Apple 那边手动换），Folia 手上那首会停在
 * 点歌那一刻。播放页的标题、歌手、专辑名、歌词都按 `currentSong` 取，所以必须用外部
 * 播放器报回来的身份重建一遍——这是「界面信息全部读自外部播放器」的那一半。
 *
 * 只用于展示与歌词匹配：媒体 id 用目录 id，`sourceRef` 标成 apple，`resolveAppleCatalogId`
 * 才认得出它仍是外部曲目，后续命令与镜像都不会把它当本地曲目。
 */
export const buildMirroredAppleSong = (track: {
    id?: string | null;
    catalogId?: string | null;
    title?: string | null;
    artist?: string | null;
    album?: string | null;
    coverUrl?: string | null;
    durationMs?: number | null;
}): SongResult => {
    const catalogId = track.catalogId || undefined;
    const mediaId = catalogId || track.id || '';
    const albumName = track.album || '';
    const coverUrl = track.coverUrl || undefined;
    const artistName = track.artist || '';
    return {
        id: mediaId as SongResult['id'],
        name: track.title || 'Now Playing',
        // 和 appleNormalize 同一套拆分规则，多歌手时逐个建 Artist。
        artists: artistName
            ? artistName
                .split(/\s*(?:,\s*|&\s*|\s+feat\.\s+|\s+with\s+)/i)
                .map((name) => name.trim())
                .filter(Boolean)
                .map((name) => ({ id: name as SongResult['id'], name }))
            : [],
        album: {
            id: albumName as SongResult['id'],
            name: albumName,
            ...(coverUrl ? { coverUrl } : {}),
        },
        durationMs: track.durationMs ?? 0,
        sourceRef: {
            kind: 'online',
            providerId: 'apple',
            mediaId,
            providerData: {
                // 目录 id 缺席（资料库曲目、Apple 没给 catalogId）时退回播放器自己的条目 id：
                // `resolveAppleCatalogId` 认的是「providerData.catalogId 是个非空字符串」，
                // 给 null 的话下一轮镜像会把这首当成「本地曲目」，然后整条镜像就此停摆。
                catalogId: catalogId ?? (track.id || null),
                albumName,
            },
        },
    };
};
