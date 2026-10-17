import { createRequire } from 'node:module';

// test/manual/apple_provider_live.mts
//
// 步 2 的实机验收：让**真实的** transport / provider / normalize 代码，经由**真实的** CDP 桥，
// 打到用户自己已登录的 Apple Music 浏览器上，读回真实曲库。
//
// 之所以是 manual 而不是单测：它需要一个已登录 music.apple.com 的浏览器在 9222 端口上等着，
// 这是本机环境而不是可提交的夹具。单测覆盖逻辑分支，这里覆盖「契约在真实数据上成立」——
// 写这个脚本的第一版就跑出了一个单测抓不到的错（拿 `hasCatalog` 预判纯本地歌单，
// 结果把 111 首云端曲目跳成了空列表），所以它值得留下。
//
// 唯一被替身顶掉的环节是 Electron 的那一跳 IPC —— 渲染进程里是
// `window.electron.appleMusicRequest` → `ipcMain.handle('apple-music-request')` → 桥；
// 这里直接把 `appleMusicRequest` 接到 `createAppleMusicBridge()` 上，其余全是真代码：
// 桥的 16 项操作白名单、CDP 连接、健康检查、参数钳制、错误码映射都会真的跑一遍。
//
//   npm run manual:apple-provider
//
// 前置：一个开着 --remote-debugging-port=9222 且已登录 music.apple.com 的浏览器。
// 全量翻 2457 首曲目约 25 次请求，整体几十秒。

import { appleProvider } from '@/services/onlineMusic/appleProvider';
import { appleLibrary } from '@/services/onlineMusic/appleLibrary';
import { appleCatalog } from '@/services/onlineMusic/appleCatalog';
import { getAppleTransportAvailability, requestApple } from '@/services/onlineMusic/appleTransport';
import { getAppleCatalogId } from '@/services/onlineMusic/appleNormalize';
import type { UnifiedSong } from '@/types';
import type { ProviderCollection } from '@/types/onlineMusic';

const require = createRequire(import.meta.url);
const { createAppleMusicBridge } = require('../../electron/appleMusicBridge.cjs') as {
    createAppleMusicBridge: (options?: Record<string, unknown>) => {
        request: (operation: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
};

const bridge = createAppleMusicBridge({ warn: () => { /* 预期的降级不刷屏 */ } });
(globalThis as any).window = {
    electron: {
        appleMusicRequest: (operation: string, params: Record<string, unknown>) => bridge.request(operation, params),
    },
};

let passed = 0;
let failed = 0;
const check = (label: string, condition: boolean, detail = '') => {
    if (condition) { passed += 1; console.log(`PASS  ${label}${detail ? '  — ' + detail : ''}`); }
    else { failed += 1; console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
};

/** 翻完一个歌单的全部曲目，顺带验证防死循环与 nextOffset 推进。 */
const drainPlaylist = async (playlist: ProviderCollection) => {
    const items: UnifiedSong[] = [];
    let offset = 0;
    for (let page = 0; page < 40; page += 1) {
        const result = await appleCatalog.getPlaylistTracks!(playlist.id, 100, offset, playlist);
        items.push(...result.items);
        if (!result.hasMore) return { items, total: result.total ?? items.length, pages: page + 1 };
        if (result.nextOffset <= offset) throw new Error(`${playlist.name}: nextOffset 没有推进（${result.nextOffset}）`);
        offset = result.nextOffset;
    }
    throw new Error(`${playlist.name}: 翻页没有收敛`);
};

/** `parserCore` 会把适配后的歌词结构整棵 dump 到 console；验收输出只要结论，跑歌词时静音。 */
const quietly = async <T,>(run: () => Promise<T>): Promise<T> => {
    const original = console.log;
    console.log = () => {};
    try { return await run(); } finally { console.log = original; }
};

const main = async () => {
    console.log('Apple Music 数据层实机验收（真实 provider → 真实桥 → 真实浏览器）\n');

    check('桌面桥可用性为已配置', getAppleTransportAvailability().configured === true);

    // 1) 会话
    const session = await requestApple<any>('session');
    check('会话有效（已登录）', session?.auth === true && session?.sf === 'cn',
        `storefront=${session?.sf} authorized=${session?.auth} tokenLen=${session?.tokLen} userTokenLen=${session?.usrLen}`);

    // 2) 歌单列表：步 2 的验收标准 —— 22 张
    const playlists: ProviderCollection[] = [];
    for (let offset = 0; ; offset += 100) {
        const page = await appleLibrary.getUserPlaylists!('me', 100, offset);
        playlists.push(...page.items);
        if (!page.hasMore) break;
        if (offset > 1000) break;
    }
    check('曲库歌单数为 22', playlists.length === 22,
        `实际 ${playlists.length}：${playlists.slice(0, 4).map(p => p.name).join(' / ')} …`);
    check('歌单都带 providerId=apple 与 type=playlist',
        playlists.every(p => p.providerId === 'apple' && p.type === 'playlist'));
    check('歌单封面已展开尺寸占位符',
        playlists.filter(p => p.coverUrl).every(p => !p.coverUrl!.includes('{w}')),
        `${playlists.filter(p => p.coverUrl).length}/22 有封面`);

    // 3) 逐张翻完：22 张里只有「本地」没有云端曲目，其余都必须取到曲目且不抛错。
    console.log('\n--- 逐张歌单全量翻页 ---');
    const failures: string[] = [];
    const empties: string[] = [];
    let trackTotal = 0;
    for (const playlist of playlists) {
        try {
            const { items, total, pages } = await drainPlaylist(playlist);
            trackTotal += items.length;
            if (items.length === 0) empties.push(playlist.name);
            const mismatch = total !== items.length ? `  ⚠ total=${total} 与实取 ${items.length} 不一致` : '';
            console.log(`  ${playlist.name.padEnd(20)} ${String(items.length).padStart(4)} 首 / ${pages} 页${mismatch}`);
        } catch (error: any) {
            failures.push(`${playlist.name}: ${error?.code || ''} ${error?.message}`);
        }
    }
    check('没有一张歌单抛错', failures.length === 0, failures.join(' | ') || `全部 ${playlists.length} 张可读`);
    check('空歌单恰好只有「本地」一张', empties.length === 1 && empties[0] === '本地', `空的：${empties.join(', ') || '无'}`);
    check('曲目总数与全量导出记录一致（2457）', trackTotal === 2457, `实取 ${trackTotal}`);

    // 4) 曲库规模：meta.total 直接给出，是端到端最硬的一组数
    const songs = await requestApple<any>('library_songs', { limit: 1, offset: 0 });
    const albums = await requestApple<any>('library_albums', { limit: 1, offset: 0 });
    const artists = await requestApple<any>('library_artists', { limit: 1, offset: 0 });
    check('曲库歌曲 1096', songs?.meta?.total === 1096, `total=${songs?.meta?.total}`);
    check('曲库专辑 939', albums?.meta?.total === 939, `total=${albums?.meta?.total}`);
    check('曲库艺人 639', artists?.meta?.total === 639, `total=${artists?.meta?.total}`);

    // 5) 曲库歌曲的归一化（拿最大那张歌单的首条做样本还要依赖歌单，这里直取曲库）
    const firstSong = appleProvider.normalizeSong(songs?.data?.[0]);
    check('曲库歌曲归一化后有 id/name/sourceRef',
        Boolean(firstSong.id && firstSong.name && firstSong.sourceRef?.kind === 'online' && firstSong.sourceRef.providerId === 'apple'),
        `《${firstSong.name}》— ${firstSong.artists.map(a => a.name).join(', ')} / ${(firstSong.durationMs / 1000).toFixed(0)}s`);

    // 6) 检索
    const search = await appleProvider.search!.searchSongs('七里香', 5, 0);
    check('目录检索命中', search.items.length > 0, `命中 ${search.items.length} 首，首条「${search.items[0]?.name}」`);

    // 7) 歌词：真实 TTML；以及「没有 catalogId 就不发请求」的短路
    // 用 provider 自己的解析器挑样本，而不是在这里重新读一遍判别联合的字段。
    const sample = search.items.find(song => getAppleCatalogId(song))
        ?? (await drainPlaylist(playlists[1])).items[0];
    const lyrics = await quietly(() => appleProvider.lyrics!.getLyrics(sample));
    check('真实曲目取到并解析了 TTML 歌词', Boolean(lyrics.lyrics?.lines?.length),
        `《${sample.name}》${lyrics.lyrics?.lines?.length ?? 0} 行 isWordByWord=${lyrics.lyrics?.isWordByWord} isPureMusic=${lyrics.isPureMusic}`);

    // 曲库行才是「可能没有 catalogId」的形态：id 与 mediaId 都带 `i.` 前缀。
    // 不能拿目录行的样本改 providerData —— 目录行的 id 本身就是纯数字，仍会被判为 catalogId。
    const noCatalogId: UnifiedSong = {
        ...sample,
        id: 'i.qQdGaLEuXeXRKWV',
        sourceRef: { kind: 'online', providerId: 'apple', mediaId: 'i.qQdGaLEuXeXRKWV', providerData: {} },
    };
    const shortCircuit = await quietly(() => appleProvider.lyrics!.getLyrics(noCatalogId));
    check('无 catalogId 的曲目不发请求、返回无歌词', shortCircuit.lyrics === null && shortCircuit.isPureMusic === false);

    // 8) 错误路径：真实 404 要落成 unsupported，而不是伪装成成功
    let unsupported = false;
    try {
        await requestApple('catalog_song', { id: '1' });
    } catch (error: any) {
        unsupported = error?.code === 'unsupported';
    }
    check('不存在的目录 id 归为 unsupported', unsupported);

    console.log(`\n${passed}/${passed + failed} 通过`);
    process.exit(failed === 0 ? 0 : 1);
};

main().catch(error => {
    console.error('\n验收中断：', error?.message || error);
    process.exit(1);
});
