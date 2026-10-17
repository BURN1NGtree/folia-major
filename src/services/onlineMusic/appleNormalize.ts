import type { Artist, UnifiedSong } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import type {
    JsonValue,
    MediaId,
    ProviderCollection,
    ProviderPage,
} from '../../types/onlineMusic';

// src/services/onlineMusic/appleNormalize.ts

/**
 * Apple Music（网页版 / amp-api）原始响应 → Omni 共享类型。
 *
 * 所有字段名与边界都来自对真实曲库的一次性导出实测
 * （22 张歌单 / 2457 首曲目 / 1096 首曲库歌曲 / 939 张专辑 / 639 位艺人），
 * 不是从文档猜的：
 *
 * - 曲库行用 `i.` / `l.` / `p.` / `r.` 前缀的 **library id**；目录端点（歌词、检索、
 *   单曲页）只认 `attributes.playParams.catalogId` 里的纯数字目录 id。
 *   1096 首里有 10 首**没有 catalogId**，所以它必须全程当作可选值。
 * - 封面 URL 带 `{w}x{h}` 模板占位符，`utils/coverUrl` 的已知 CDN 规则不覆盖它，
 *   所以必须在入库前替换掉，否则 `<img>` 拿到的是字面量 `{w}x{h}`。
 * - 曲库行的 `dateAdded` 可能是 `1970-01-01T00:00:00Z`（epoch 0）表示「从未」，
 *   直接显示会变成 1970 年。
 * - 曲库歌单可能是纯本地歌单：详情端点返回 404、没有 artwork，且曲目为空。
 */

/** Apple 封面 CDN 的尺寸占位符。 */
const ARTWORK_PLACEHOLDER_PATTERN = /\{w\}x\{h\}/g;

/** 默认封面边长。Apple 的 artwork 常带 1200 的原图尺寸，600 足够列表与播放页用。 */
export const APPLE_ARTWORK_DEFAULT_SIZE = 600;

const record = (value: unknown): any => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);

const text = (value: unknown): string => (
    value === undefined || value === null ? '' : String(value).trim()
);

const finiteNumber = (value: unknown): number | undefined => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

/** 只保留能安全进 JSON 的标量，避免把整个上游对象写进 providerData。 */
const jsonData = (entries: Array<[string, unknown]>): Record<string, JsonValue> => Object.fromEntries(
    entries.filter((entry): entry is [string, JsonValue] => (
        entry[1] === null || ['string', 'number', 'boolean'].includes(typeof entry[1])
    )),
);

/**
 * 把 Apple 的封面模板解析成可直接加载的 URL。
 * 拿不到模板时退回原串（可能已经是具体尺寸），拿不到 URL 时返回 undefined。
 */
export const resolveAppleArtworkUrl = (artwork: unknown, size = APPLE_ARTWORK_DEFAULT_SIZE): string | undefined => {
    const url = text(record(artwork).url);
    if (!url) return undefined;
    const rounded = Math.max(1, Math.round(size));
    return url.replace(ARTWORK_PLACEHOLDER_PATTERN, `${rounded}x${rounded}`);
};

/**
 * 曲库行上的目录 id。歌词、目录检索与单曲页都要它，而库内端点要的是 library id。
 * 缺它就是缺（10/1096 的实测比例），调用方必须自行处理 undefined。
 */
export const getAppleCatalogId = (raw: unknown): string | undefined => {
    const item = record(raw);
    const playParams = record(record(item.attributes).playParams);
    const fromPlayParams = text(playParams.catalogId);
    if (fromPlayParams) return fromPlayParams;
    const fromProviderData = text(record(record(item.sourceRef).providerData).catalogId);
    if (fromProviderData) return fromProviderData;
    // 目录行（检索结果、/v1/catalog/.../songs）**没有** playParams.catalogId：
    //   目录行  playParams = { id: "536115195", kind: "song" }
    //   曲库行  playParams = { catalogId: "913927780", id: "i.xxx", isLibrary: true }
    // 两者的 playParams.id 含义相反，所以不能直接取 —— 只有纯数字才可能是目录 id，
    // 曲库 id 带 `i.` / `l.` / `p.` / `r.` 前缀。少了这条回退，检索来的歌一律拿不到
    // catalogId，歌词全部 404。
    const candidates = [text(playParams.id), text(item.id)];
    return candidates.find(candidate => /^\d+$/.test(candidate));
};

/**
 * Apple 的时间戳。epoch 0 在曲库行里表示「从未」而不是 1970 年，按未给出处理。
 */
export const getAppleTimestamp = (value: unknown): number | undefined => {
    const raw = text(value);
    if (!raw) return undefined;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return parsed;
};

/**
 * Apple 只给一个扁平的 `artistName` 字符串，多艺人用 `, ` / ` & ` / ` feat. ` 连接，
 * 曲库响应里没有艺人 id。所以 id 退化成名字本身：它能稳定参与去重与展示，
 * 但不该被当成可查询的目录 id 使用（那需要 `/v1/catalog/.../artists`）。
 */
export const normalizeAppleArtists = (artistName: unknown): Artist[] => {
    const raw = text(artistName);
    if (!raw) return [];
    return raw
        .split(/\s*(?:,\s*|&\s*|\s+feat\.\s+|\s+with\s+)/i)
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({ id: name as MediaId, name }));
};

/** 曲库行 → UnifiedSong。库内身份是 `i.` 开头的 library id。 */
export const normalizeAppleSong = (raw: unknown): UnifiedSong => {
    const item = record(raw);
    const attributes = record(item.attributes);
    const playParams = record(attributes.playParams);

    const libraryId = text(item.id);
    const catalogId = getAppleCatalogId(item);
    const albumName = text(attributes.albumName);
    const coverUrl = resolveAppleArtworkUrl(attributes.artwork);
    const durationMs = finiteNumber(attributes.durationInMillis) ?? 0;
    const trackNumber = finiteNumber(attributes.trackNumber);
    const discNumber = finiteNumber(attributes.discNumber);
    const releaseDate = text(attributes.releaseDate);
    const genreNames = Array.isArray(attributes.genreNames) ? attributes.genreNames.map(text).filter(Boolean) : [];

    // 库内 id 是主键；万一上游没给（不该发生），退回目录 id 保证身份不塌成空串。
    const mediaId = libraryId || catalogId || '';

    return {
        id: (libraryId || catalogId || '') as MediaId,
        name: text(attributes.name) || 'Unknown Song',
        artists: normalizeAppleArtists(attributes.artistName),
        album: {
            // 曲库歌曲不给专辑 id，只有专辑名。它是展示用的键，不带 catalogRef，
            // 所以导航层不会拿它去查专辑（专辑级跳转走 /v1/me/library/albums 的 `l.` id）。
            id: (albumName || '') as MediaId,
            name: albumName,
            ...(coverUrl ? { coverUrl } : {}),
        },
        durationMs,
        sourceRef: {
            kind: 'online',
            providerId: 'apple',
            mediaId,
            providerData: jsonData([
                ['catalogId', catalogId ?? null],
                ['albumName', albumName],
                ['hasLyrics', typeof attributes.hasLyrics === 'boolean' ? attributes.hasLyrics : null],
                ['trackNumber', trackNumber ?? null],
                ['discNumber', discNumber ?? null],
                ['releaseDate', releaseDate],
                ['genre', genreNames[0] ?? null],
                ['isLibrary', typeof playParams.isLibrary === 'boolean' ? playParams.isLibrary : null],
            ]),
        },
    };
};

/**
 * 分页信封。
 *
 * Apple 只给相对 `next` 路径，而 `ProviderPage.nextOffset` 要绝对偏移；nextOffset 由我们自己
 * 按取回条数推算，**不**解析 `next`。
 *
 * `next` 是比 total 更可靠的「还有下一页」信号：目录检索的分组里根本没有 total，
 * 只有 next。所以有 next 就信它；next 明确缺席时才退回「取满一页即视为还有」。
 */
export const applePage = <T>(items: T[], total: unknown, offset: number, limit: number, next?: unknown): ProviderPage<T> => {
    const count = Number(total);
    const knownTotal = total != null && Number.isFinite(count) && count >= 0;
    const nextOffset = offset + items.length;
    const hasNext = typeof next === 'string' && next.length > 0;
    const hasMore = next != null
        ? hasNext
        : items.length > 0 && (knownTotal ? nextOffset < count : items.length === limit);
    return {
        items,
        ...(knownTotal ? { total: count } : {}),
        nextOffset,
        hasMore,
    };
};

/**
 * `{ data, meta, next }` 信封 → ProviderPage。曲库端点给 `meta.total`，目录检索端点不给。
 */
export const applePageFromResponse = <T>(
    response: unknown,
    operation: string,
    offset: number,
    limit: number,
    map: (raw: unknown) => T,
): ProviderPage<T> => {
    const envelope = record(response);
    const data = envelope.data;
    if (!Array.isArray(data)) {
        throw new OnlineProviderError('invalid-response', `Apple ${operation} response has no data array`, 'apple');
    }
    return applePage(data.map(map), record(envelope.meta).total, offset, limit, envelope.next);
};

/** 单对象信封 `{ data: [one] }` → 第一个元素；空数组就是上游说「没有」。 */
export const appleFirstFromResponse = (response: unknown): unknown => {
    const data = record(response).data;
    return Array.isArray(data) ? data[0] : undefined;
};

/** 曲库歌单 / 专辑 / 艺人 → ProviderCollection。 */
export const normalizeAppleCollection = (raw: unknown, type?: string): ProviderCollection => {
    const item = record(raw);
    const attributes = record(item.attributes);
    const playParams = record(attributes.playParams);
    const name = text(attributes.name);

    // Apple 的行类型是 library-playlists / library-albums / library-artists；
    // 显式传入的 type 优先，其次由行类型推断。
    const rowType = text(item.type);
    const resolvedType = text(type)
        || (rowType.includes('playlist') ? 'playlist'
            : rowType.includes('album') ? 'album'
                : rowType.includes('artist') ? 'artist' : 'playlist');

    const coverUrl = resolveAppleArtworkUrl(attributes.artwork);
    const trackCount = finiteNumber(attributes.trackCount);
    const lastModified = getAppleTimestamp(attributes.lastModifiedDate);

    return {
        providerId: 'apple',
        id: text(item.id) as MediaId,
        name,
        type: resolvedType,
        ...(coverUrl ? { coverUrl } : {}),
        ...(trackCount !== undefined ? { trackCount } : {}),
        // canEdit 为真时才可能被修改；只读浏览仍然读它来标出「自己的歌单」。
        ...(typeof attributes.canEdit === 'boolean' ? { isOwned: attributes.canEdit } : {}),
        ...(lastModified !== undefined ? { updatedAt: lastModified } : {}),
        // 专辑行带 artistName：专辑页签要显示歌手（此前只写进 providerData，卡片回落成「未知歌手」）。
        // 这里不按 & / feat. 拆——专辑的 artistName 常是「Simon & Garfunkel」这类复合专名。
        ...(resolvedType === 'album' && text(attributes.artistName)
            ? { artists: [{ id: text(attributes.artistName) as MediaId, name: text(attributes.artistName) }] }
            : {}),
        ...(resolvedType === 'artist' && name ? { artists: normalizeAppleArtists(name) } : {}),
        providerData: jsonData([
            ['globalId', text(playParams.globalId) || null],
            ['isPublic', typeof attributes.isPublic === 'boolean' ? attributes.isPublic : null],
            ['canEdit', typeof attributes.canEdit === 'boolean' ? attributes.canEdit : null],
            ['canDelete', typeof attributes.canDelete === 'boolean' ? attributes.canDelete : null],
            // 原样保留，但**不要**拿它当「有没有云端曲目」用：实测 hasCatalog=false 的「喜爱歌曲」
            // 有 111 首云端曲目，而真正 `/tracks` 404 的纯本地「本地」是 true。判定见 appleCatalog.ts。
            ['hasCatalog', typeof attributes.hasCatalog === 'boolean' ? attributes.hasCatalog : null],
            ['hasCollaboration', typeof attributes.hasCollaboration === 'boolean' ? attributes.hasCollaboration : null],
            ['dateAdded', text(attributes.dateAdded) || null],
            ['lastModifiedDate', text(attributes.lastModifiedDate) || null],
            ['releaseDate', text(attributes.releaseDate) || null],
            ['artistName', text(attributes.artistName) || null],
        ]),
    };
};
