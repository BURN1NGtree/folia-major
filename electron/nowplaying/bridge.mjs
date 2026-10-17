/**
 * Apple Music → Folia now-playing 桥（步 3 方向 1）
 *
 * 作用：把 Edge 里 music.apple.com 的 MusicKit 播放状态，翻译成 Folia「Now Playing」
 *      舞台源认识的 9863 协议，使 Folia 舞台跟着 Apple Music 显示封面 / 标题 / 歌词。
 *      不修改 Folia 一行代码（遵守二次开发约束②）。
 *
 * 协议（读 src/services/nowPlayingProvider.ts 与 src/utils/nowPlayingClock.ts 得到）：
 *   WS   ws://localhost:9863/api/ws/lyric     事件 {event, data}
 *        - 'Track'            {id, title, author, album, cover, duration}   duration 单位 ms
 *        - 'Lyric'            {source, title, author, duration, hasLyric, lrc, translatedLyric, ...}
 *        - 'PlayerPauseState' {hasSong, isPaused, seekbarCurrentPosition, statePercent}
 *                             seekbarCurrentPosition 单位是**秒**（<= 时长+1 时按秒解释）
 *        - 'PlayerProgress'   {progress}                                    progress 单位 ms
 *        - 'Queue'            {position, items:[{id,title,artist,album,cover,durationMs}]}
 *                             待播清单**整份快照**（只读）。只在队列变化时发一次，不跟轮询跑。
 *   HTTP http://localhost:9863/api/query/progress -> {progress: <ms>}
 *
 * 三条实测结论直接决定了下面的写法：
 *   ① 页面隐藏/冻结时 fetch 回调投递不进来，promise 永不 settle —— 取歌词前必须
 *      Page.setWebLifecycleState('active') 解冻。冻结对抗的是「收结果」，不是「发请求」。
 *   ② PlayerPauseState 的进度会被 5 秒内的 PlayerProgress 覆盖（lastPreciseProgressMs），
 *      所以暂停/拖动时先发精确的 PlayerProgress，再发 PlayerPauseState，位置才准。
 *   ③ 封面 URL 带 {w}x{h} 模板占位符，必须替换成具体尺寸，否则 <img> 拿到字面量。
 *      尺寸取 600，与步 2 的 appleNormalize.APPLE_ARTWORK_DEFAULT_SIZE 保持一致。
 *
 * 用法：
 *   node bridge.mjs            # 起桥（前台常驻）
 *   node bridge.mjs --once     # 只打一份当前快照 + 歌词转换结果就退出（自检用）
 * 环境变量：CDP_PORT(9222) BRIDGE_PORT(9863) AMP_HOST(music.apple.com 页面匹配) POLL_MS(120)
 */
// electron/nowplaying/bridge.mjs
// 内置版：由 electron/nowplaying/supervisor.cjs 以 utilityProcess 拉起，跟随 Apple 音源的使用
// 自动启停（用户切到 Apple 才起，Folia 退出时一起结束）。逻辑与研究脚本一致，只改了 import。
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { connect, sleep } from './cdp-lib.mjs';

// —— 配置 ——————————————————————————————————————————————————————————————
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 9863);
const PAGE_MATCH = process.env.AMP_HOST || 'music.apple.com';
const POLL_MS = Number(process.env.POLL_MS || 120);
// 进度推送间隔。Folia 那边还会用本地单调时钟在两次推送之间做插值，所以这里不必推得太密；
// 200ms 只是让「seek / 暂停 / 换曲」这类突变最迟 200ms 就被看见。
const PROGRESS_PUSH_MS = 100;
// 待播清单整份重取的间隔。队列归 Apple 所有，Folia 开着就一直对齐：默认 1 秒重取一次，
// 逐首比对 id，只有真的变了才广播（见 refreshQueueSnapshot）。
const QUEUE_REFRESH_MS = Number(process.env.QUEUE_REFRESH_MS || 1000);
const AMP_API = 'https://amp-api.music.apple.com';
const ARTWORK_SIZE = 600;
const ONCE = process.argv.includes('--once');

// ws 取应用自身的依赖（内置后不再指向仓库外的 folia-major 路径）。
// 打包成 asar 后 utilityProcess 仍能正常解析 node_modules，这里与 electron/analysis/host.cjs 的做法一致。
const requireFromApp = createRequire(import.meta.url);
const { WebSocketServer } = requireFromApp('ws');

const log = (...args) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...args);

// —— TTML → LRC ————————————————————————————————————————————————————————
// Apple 的歌词 TTML 实测是机器生成的规整结构，且同一份文件里 begin 可能是小数秒
// ("27.549")也可能是分:秒 ("1:01.308")，两种都要认。itunes:timing 可能是 Line
// （<p> 里直接是文本）也可能是 Word（<p> 里再套 <span>），统一按「剥掉标签取文本」处理。

/** 把 TTML 的时间值解析成秒；支持 "27.549" 与 "1:01.308" 两种写法。 */
function parseTtmlTime(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  const colonForm = /^(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (colonForm) return Number(colonForm[1]) * 60 + Number(colonForm[2]);
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

/** 秒 → LRC 时间戳 [mm:ss.xx]（厘秒，LRC 最通用的精度）。 */
function formatLrcTime(seconds) {
  const centis = Math.max(0, Math.round(seconds * 100));
  const mm = String(Math.floor(centis / 6000)).padStart(2, '0');
  const ss = String(Math.floor((centis % 6000) / 100)).padStart(2, '0');
  const xx = String(centis % 100).padStart(2, '0');
  return `[${mm}:${ss}.${xx}]`;
}

const decodeXmlEntities = (value) => String(value)
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

const stripTags = (value) => decodeXmlEntities(String(value).replace(/<[^>]*>/g, '')).trim();

const TRANSLATION_SPAN_RE = /<span\b[^>]*ttm:role="x-translation"[^>]*>([\s\S]*?)<\/span>/g;

/**
 * 把 Apple 的歌词 TTML 转成 LRC。
 *
 * 返回 null 表示「这份 TTML 没有可用的按行歌词」。判定规则：只要一行原文都没有就返回 null，
 * 哪怕抽到了翻译 —— 主歌词才是 UI 的驱动源，只有译文的载荷在 Folia 里没有意义，
 * 返回 null 会让桥推 hasLyric:false，界面干净地不显示歌词，好过显示一份无原文的译文。
 */
export function ttmlToLrc(ttml) {
  if (typeof ttml !== 'string' || !ttml.includes('<p')) return null;

  const lines = [];
  const translations = [];
  const paragraphRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;

  let match;
  while ((match = paragraphRe.exec(ttml)) !== null) {
    const attrs = match[1];
    const inner = match[2];
    const beginSec = parseTtmlTime((/\bbegin="([^"]+)"/.exec(attrs) || [])[1]);
    if (beginSec === null) continue;

    // 先把翻译 span 抽走，剩下的才是原文，避免原文里混进译文
    const translationParts = [];
    const originalInner = inner.replace(TRANSLATION_SPAN_RE, (_, text) => {
      const cleaned = stripTags(text);
      if (cleaned) translationParts.push(cleaned);
      return '';
    });

    const originalText = stripTags(originalInner);
    if (originalText) lines.push(`${formatLrcTime(beginSec)}${originalText}`);
    if (translationParts.length > 0) {
      translations.push(`${formatLrcTime(beginSec)}${translationParts.join(' ')}`);
    }
  }

  if (lines.length === 0) return null;
  lines.sort();
  translations.sort();

  return {
    lineCount: lines.length,
    lrc: lines.join('\n'),
    translatedLyric: translations.length > 0 ? translations.join('\n') : null,
  };
}

// —— 封面 URL ——————————————————————————————————————————————————————————
/** 把 Apple 封面模板里的 {w}/{h} 替换成具体尺寸；没有模板就原样返回。 */
export function resolveArtworkUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  return url
    .replace(/\{w\}/g, String(ARTWORK_SIZE))
    .replace(/\{h\}/g, String(ARTWORK_SIZE))
    .replace(/\{f\}/g, 'jpg');
}

// —— 页面侧表达式 ——————————————————————————————————————————————————————
// 刻意用独立全局名 __NP，不与步 2 数据桥的 __AM 互相覆盖，两个桥可以同时开着。

const STATE_EXPR = `(() => {
  const m = (window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance());
  if (!m) return { ready: false };
  const it = m.nowPlayingItem;
  const attrs = (it && it.attributes) || null;
  return {
    ready: true,
    isPlaying: !!m.isPlaying,
    playbackState: m.playbackState,
    positionSec: typeof m.currentPlaybackTime === 'number' ? m.currentPlaybackTime : 0,
    storefront: m.storefrontId || 'cn',
    // 循环 / 随机模式。这两个是 MusicKit 的**可写属性**（不是方法——setRepeatMode 在实例上
    // 是 undefined，按方法名找会误判成「改不了」）。Cider 的做法就是直接赋值：
    //   mk.repeatMode = MusicKit.PlayerRepeatMode['none'|'one'|'all']
    //   mk.shuffleMode = MusicKit.PlayerShuffleMode['off'|'songs']
    // 读侧给 Folia 做双向同步：用户在 Apple 页面改了，Folia 的按钮要跟着变。
    repeatMode: m.repeatMode,
    shuffleMode: m.shuffleMode,
    item: it ? {
      id: it.id || null,
      playParamsId: (it.playParams && it.playParams.id) || null,
      catalogId: (it.playParams && it.playParams.catalogId) || null,
      title: it.title || (attrs && attrs.name) || null,
      artist: it.artistName || (attrs && attrs.artistName) || null,
      album: it.albumName || (attrs && attrs.albumName) || null,
      durationMs: it.playbackDuration
        || (attrs && attrs.durationInMillis ? attrs.durationInMillis : null),
      artworkUrl: it.artworkURL
        || (attrs && attrs.artwork && attrs.artwork.url) || null,
      hasLyrics: !!(attrs && attrs.hasLyrics),
    } : null,
    // 队列实况。队列驱动的命令（playSong 带 ids）要读它：本机实测 changeToMediaAtIndex /
    // skipToNextItem 之后 queue.position 立刻更新，而 nowPlayingItem 要滞后一会儿才跟上，
    // 只看 item 会把已经生效的命令判成没生效。
    queue: (() => {
      const q = m.queue || {};
      const items = q.items || [];
      const idOf = (i) => (i && i.playParams && (i.playParams.catalogId || i.playParams.id)) || (i && i.id) || null;
      return {
        length: items.length,
        position: typeof q.position === 'number' ? q.position : -1,
        itemIds: items.map((i) => String(idOf(i) || '')),
        titles: items.map((i) => (i && (i.title || (i.attributes && i.attributes.name))) || null),
      };
    })(),
    // 页面侧记的最近一次命令结局（含 playSong 的专辑队列决策：albumId / index / fellBack）。
    // 只读诊断用：命令走没走到「建队列、定位」那一步，全靠它。
    lastCommand: (window.__NP && window.__NP.lastCommand) || null,
  };
})()`;

const INSTALL_EXPR = `(() => {
  const mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
  if (!mk) return { ok: false, error: 'MusicKit 未就绪' };
  // 只补字段，不要整体替换 __NP：CONTROL_EXPR 也往它上面挂 lastCommand（含 playSong 的
  // 专辑队列决策）。整体替换会把诊断信息抹掉，而且 done() 随后写 lastCommand.ok 会抛错
  // —— 取歌词时 ensureHelper() 一跑就正好触发这个时序。
  window.__NP = window.__NP || {};
  Object.assign(window.__NP, {
    mp: mk,
    tok: mk.developerToken,
    usr: mk.musicUserToken,
    sf: mk.storefrontId || 'cn',
    async get(path) {
      const res = await fetch(${JSON.stringify(AMP_API)} + path, {
        headers: {
          'Authorization': 'Bearer ' + window.__NP.tok,
          'media-user-token': window.__NP.usr,
        },
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON：保留 textHead 供排查 */ }
      return { status: res.status, ok: res.ok, json, textHead: json ? null : text.slice(0, 200) };
    },
  });
  return { ok: true, sf: window.__NP.sf, tokLen: window.__NP.tok.length };
})()`;

// 待播清单快照：**只读**，给 Folia 的队列面板直接渲染用。
// 只在队列真的变了（换队列 / 随机重排 / 增删 / 播到下一首）时才取一次，不跟 120ms 轮询跑——
// 477 首整份带上去差不多 80KB，跟着轮询发会把 WS 压死。
const QUEUE_EXPR = `(() => {
  const mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
  if (!mk) return { ok: false, error: 'MusicKit 未就绪' };
  const queue = mk.queue;
  if (!queue) return { ok: false, error: '队列不可用' };
  // 以 queue.items 为准：STATE_EXPR 读的是同一份数组，两边必须同源。
  // 实测 queue.length / queue.item(i) 会滞后于 queue.items，会出现「曲目已是新队列、
  // 待播清单还停在旧队列」——UI 上就是拼贴墙不跟播放队列走。
  const list = Array.isArray(queue.items) ? queue.items : null;
  const count = list ? list.length : (Number.isFinite(queue.length) ? queue.length : 0);
  const at = (i) => (list ? list[i] : queue.item(i));
  const idOf = (it) => {
    const p = (it && it.playParams) || {};
    if (p.catalogId) return String(p.catalogId);
    return it && it.id ? String(it.id) : null;
  };
  const items = [];
  for (let i = 0; i < count; i += 1) {
    const it = at(i) || {};
    const artwork = it.artwork && typeof it.artwork.url === 'string' ? it.artwork.url : null;
    items.push({
      id: idOf(it),
      title: it.title || null,
      artist: it.artistName || null,
      album: it.albumName || null,
      cover: artwork ? artwork.replace('{w}x{h}', '300x300') : null,
      durationMs: Number.isFinite(it.durationInMillis) ? it.durationInMillis : null,
    });
  }
  const nowId = idOf(mk.nowPlayingItem);
  let position = Number.isFinite(queue.position) ? queue.position : -1;
  if (position < 0 && nowId) {
    const found = items.findIndex((item) => item.id === nowId);
    if (found >= 0) position = found;
  }
  return { ok: true, position, items };
})()`;

// 播控命令。**刻意不 await**：冻结页里的命令 promise 会一直 pending（实测），
// await 它等于把「命令已发出」误报成「命令失败」。真正的判据是之后读回来的 state。
const CONTROL_EXPR = (command, positionSec, catalogId, ids, mode, index) => `(() => {
  const mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
  if (!mk) return { ok: false, error: 'MusicKit 未就绪' };
  const cmd = ${JSON.stringify(command)};
  window.__NP = window.__NP || {};
  window.__NP.lastCommand = { cmd, at: Date.now() };
  const done = (ok, error) => { window.__NP.lastCommand.ok = ok; if (error) window.__NP.lastCommand.error = error; };
  try {
    if (cmd === 'play') { mk.play().then(() => done(true), (e) => done(false, String(e))); return { ok: true, dispatched: 'play' }; }
    if (cmd === 'pause') { mk.pause().then(() => done(true), (e) => done(false, String(e))); return { ok: true, dispatched: 'pause' }; }
    // toggle 在页面侧决定方向：调用方（Folia）拿不到外部播放器的真实播放状态。
    if (cmd === 'toggle') { const wasPlaying = mk.isPlaying === true; const target = wasPlaying ? 'pause' : 'play'; (wasPlaying ? mk.pause() : mk.play()).then(() => done(true), (e) => done(false, String(e))); return { ok: true, dispatched: target }; }
    if (cmd === 'next') { mk.skipToNextItem().then(() => done(true), (e) => done(false, String(e))); return { ok: true, dispatched: 'next' }; }
    if (cmd === 'previous') { mk.skipToPreviousItem().then(() => done(true), (e) => done(false, String(e))); return { ok: true, dispatched: 'previous' }; }
    if (cmd === 'seek') { mk.seekToTime(${Number(positionSec) || 0}).then(() => done(true), (e) => done(false, String(e))); return { ok: true, dispatched: 'seek' }; }
    // —— 跳到待播清单第 N 行 ——
    // 只挪播放位置、不重建队列：对应 Apple 在待播清单里点某一行时的原生行为。
    if (cmd === 'jumpToIndex') {
      const targetIndex = Number(${JSON.stringify(index)});
      const queue = mk.queue;
      const size = queue ? queue.length : 0;
      if (!queue || !(targetIndex >= 0) || targetIndex >= size) {
        return { ok: false, error: 'jumpToIndex 越界：' + targetIndex + '/' + size };
      }
      const item = queue.item(targetIndex);
      if (!item) return { ok: false, error: 'jumpToIndex 取不到第 ' + targetIndex + ' 项' };
      Promise.resolve(mk.changeToMediaItem(item)).then(() => done(true), (e) => done(false, String(e)));
      return { ok: true, dispatched: 'jumpToIndex:' + targetIndex };
    }
    // —— 循环 / 随机 ——
    // 属性赋值，不是方法调用（见 STATE_EXPR 里的说明）。枚举用 MusicKit 自己导出的，不硬编码数字：
    // PlayerRepeatMode {none:0, one:1, all:2}、PlayerShuffleMode {off:0, songs:1}。
    // 同时接受数字（0/1/2），方便直接用 Folia 侧的下标传过来。
    if (cmd === 'setRepeatMode') {
      const names = ['none', 'one', 'all'];
      const want = ${JSON.stringify(mode)};
      const key = typeof want === 'number' ? names[want] : String(want || '');
      if (names.indexOf(key) < 0) return { ok: false, error: 'setRepeatMode 需要 none|one|all，收到 ' + JSON.stringify(want) };
      const next = MusicKit.PlayerRepeatMode[key];
      mk.repeatMode = next;
      window.__NP.lastCommand.mode = { repeat: key };
      done(String(mk.repeatMode) === String(next));
      return { ok: true, dispatched: 'setRepeatMode:' + key, repeatMode: mk.repeatMode };
    }
    if (cmd === 'setShuffleMode') {
      const names = ['off', 'songs'];
      const want = ${JSON.stringify(mode)};
      const key = typeof want === 'number' ? names[want] : String(want || '');
      if (names.indexOf(key) < 0) return { ok: false, error: 'setShuffleMode 需要 off|songs，收到 ' + JSON.stringify(want) };
      const next = MusicKit.PlayerShuffleMode[key];
      mk.shuffleMode = next;
      window.__NP.lastCommand.mode = { shuffle: key };
      done(String(mk.shuffleMode) === String(next));
      return { ok: true, dispatched: 'setShuffleMode:' + key, shuffleMode: mk.shuffleMode };
    }
    // 点名播一首 Apple 曲目：Folia 拿不到流（DRM），所以「播放」只能是让 Apple Music 去播。
    // setQueue 会重置队列，所以每次播放都必须显式点名，不能假定队列里还是它。
    //
    // 关键：必须建**整张专辑**的队列，不能用 { song } 建单首队列。
    // 单首队列里 nextPlayableItemIndex / previousPlayableItemIndex 都是 -1（本机实测），
    // 于是「下一首/上一首」无处可去 —— 这正是「上一首下一首按键不能正常使用」的根因。
    //
    // setQueue 的 startWithSong 选项实测无效（建完队列 position 仍是 -1），定位只能自己来：
    // 读 queue.items 找到目标曲的 index，再 changeToMediaAtIndex(index)（实测能跳，且 next/prev 恢复正常）。
    // 解析不到专辑（单曲等）就退回单首队列：此时 skip 仍不可用，但至少能播，不会什么都不发生。
    // 电台（Apple 的「XX 的电台」「探索电台」）：不是一首歌，也不是一张专辑，而是一条动态流。
    // MusicKit 的 setQueue({ station }) 正是它的入口；建完必须再 play() 一次才真的开播。
    // 电台没有固定曲目清单，所以只回报「下发成功」，是否生效由 commandSatisfied 看播放状态。
    if (cmd === 'playStation') {
      const stationId = ${JSON.stringify(String(catalogId || ''))};
      if (!stationId) return { ok: false, error: 'playStation 需要 stationId' };
      Promise.resolve(mk.setQueue({ station: stationId }))
        .then(function () { return mk.play(); })
        .then(function () { done(true); }, function (e) { done(false, String((e && e.message) || e)); });
      return { ok: true, dispatched: 'playStation:' + stationId };
    }
    if (cmd === 'playSong') {
      const id = ${JSON.stringify(String(catalogId || ''))};
      if (!id) return { ok: false, error: 'playSong 需要 catalogId' };
      const idOf = function (i) { return (i && i.playParams && (i.playParams.catalogId || i.playParams.id)) || (i && i.id); };
      const note = { mode: null, count: null, albumId: null, index: null, fellBack: null };
      window.__NP.lastCommand.albumQueue = note;
      const playSingle = function () { note.mode = 'single'; return mk.setQueue({ song: id }).then(function () { return mk.play(); }); };
      // —— 队列驱动（Folia 点歌单）——
      // 调用方把整条歌单的 catalogId 按 Folia 的顺序送来；setQueue({ songs }) 实测会原样保留
      // 顺序（4 首乱序子集验证过），所以这里不重排。建完队列不会自动定位（position 停在 -1），
      // 必须再 changeToMediaAtIndex 一次才真正开播。
      const queueIds = ${JSON.stringify(Array.isArray(ids) ? ids.map(String).filter(Boolean) : [])};
      if (queueIds.length > 1) {
        note.mode = 'songs';
        note.count = queueIds.length;
        note.dropped = 0;
        // 关键：**一个 id 解析不了，MusicKit 会用 NOT_FOUND 拒掉整批**。
        // 实测用户那条 486 首歌单里就有 9 个在本区无法解析（下架/换区），
        // 整批被拒 → 落到 playSingle 兜底 → 队列塌成 1 首、待播列表全空。
        // 所以这里按错误消息里点名的 id 逐个剔除后重试，而不是整批放弃。
        const tryQueue = function (list, attempt) {
          return mk.setQueue({ songs: list }).then(function () {
            const items = (mk.queue && mk.queue.items) || [];
            note.count = items.length;
            note.attempts = attempt;
            const index = items.findIndex(function (i) { return String(idOf(i)) === String(id); });
            note.index = index;
            if (index < 0) { note.fellBack = 'not-in-queue'; return mk.play(); }
            return Promise.resolve(mk.changeToMediaAtIndex(index)).then(function () { return mk.play(); });
          }, function (e) {
            const msg = String((e && e.message) || e);
            const bad = [];
            const re = /\\b\\d{6,}\\b/g; let mm;
            while ((mm = re.exec(msg)) !== null) if (bad.indexOf(mm[0]) < 0) bad.push(mm[0]);
            if (bad.length && attempt < 6 && list.length - bad.length > 1) {
              note.dropped += bad.length;
              return tryQueue(list.filter(function (x) { return bad.indexOf(x) < 0; }), attempt + 1);
            }
            note.fellBack = msg.slice(0, 160);
            return playSingle().then(function () { done(true); }, function (e2) { done(false, String(e2)); });
          });
        };
        // 注意：**不能把这个 promise 从 IIFE 里 return 出去** —— evalJs 走的是
        // Runtime.evaluate + returnByValue，Promise 没法序列化，会变成「命令被页面拒绝」。
        // 和专辑那条分支一样：发射出去，然后返回一个纯对象。
        tryQueue(queueIds, 0).then(function () { done(true); }, function (e) {
          note.fellBack = String((e && e.message) || e).slice(0, 160);
          return playSingle().then(function () { done(true); }, function (e2) { done(false, String(e2)); });
        });
        return { ok: true, dispatched: 'playSong:' + id };
      }
      note.mode = 'album';
      const path = '/v1/catalog/' + encodeURIComponent(mk.storefrontId || 'cn')
        + '/songs/' + encodeURIComponent(id) + '?include=albums';
      fetch(${JSON.stringify(AMP_API)} + path, {
        headers: { 'Authorization': 'Bearer ' + mk.developerToken, 'media-user-token': mk.musicUserToken },
      })
        .then(function (res) { return res.json(); })
        .then(function (json) {
          const song = json && json.data && json.data[0];
          const albums = song && song.relationships && song.relationships.albums && song.relationships.albums.data;
          const albumId = albums && albums[0] && albums[0].id;
          if (!albumId) { note.fellBack = 'no-album'; return playSingle(); }
          note.albumId = albumId;
          return mk.setQueue({ album: albumId }).then(function () {
            const items = (mk.queue && mk.queue.items) || [];
            const index = items.findIndex(function (i) { return String(idOf(i)) === String(id); });
            note.index = index;
            if (index < 0) { note.fellBack = 'not-in-album'; return mk.play(); }
            return Promise.resolve(mk.changeToMediaAtIndex(index)).then(function () { return mk.play(); });
          });
        })
        .then(function () { done(true); }, function (e) {
          // 解析 / 建队列 / 定位任一环失败：退回单首兜底，别让「点歌」变成什么都没发生。
          note.fellBack = String((e && e.message) || e);
          return playSingle().then(function () { done(true); }, function (e2) { done(false, String(e2)); });
        });
      return { ok: true, dispatched: 'playSong:' + id };
    }
    return { ok: false, error: 'unknown command: ' + cmd };
  } catch (error) {
    done(false, String(error && error.message || error));
    return { ok: false, error: String(error && error.message || error) };
  }
})()`;

/** 命令是否已在回读的状态里生效。next/previous 不看位置，看曲目是否真的换了。 */
export function commandSatisfied(command, positionSec, state, before, catalogId, mode, index) {
  if (!state?.ready) return false;
  // 循环 / 随机：回读的属性值要等于请求的那一档（下标比较，字符串和数字两种入参都收）。
  if (command === 'setRepeatMode' || command === 'setShuffleMode') {
    const names = command === 'setRepeatMode' ? ['none', 'one', 'all'] : ['off', 'songs'];
    const key = typeof mode === 'number' ? names[mode] : String(mode || '');
    const idx = names.indexOf(key);
    if (idx < 0) return false;
    const actual = command === 'setRepeatMode' ? state.repeatMode : state.shuffleMode;
    return String(actual) === String(idx);
  }
  if (command === 'play') return state.isPlaying === true;
  // toggle 的方向由页面决定，这里只要求「和下发前不一样」。
  if (command === 'toggle') return typeof before?.isPlaying === 'boolean' ? state.isPlaying !== before.isPlaying : true;
  if (command === 'pause') return state.isPlaying === false;
  if (command === 'seek') return Math.abs((state.positionSec || 0) - positionSec) <= 3;
  // 跳行：回读的队列位置就是要的那一行。
  if (command === 'jumpToIndex') {
    const targetIndex = Number(index);
    return Number.isFinite(targetIndex) && state.queue?.position === targetIndex;
  }
  // 电台：没有可比的目标曲目，只要「有曲目在放」就算生效。
  if (command === 'playStation') return Boolean(state.item) && (state.queue?.length || 0) > 0;
  // 点名播放：既要在放，又要是点的那一首（跳错歌不算生效）。
  if (command === 'playSong') {
    const target = String(catalogId || '');
    if (!target) return false;
    // 比较链里必须有 catalogId：点名播放是按目录 id 下发的，而 playParamsId 可能是库 id
    // （i.xxx 那种），只比它会一直判成「没生效」——歌其实已经在放了。
    const now = String(state.item?.catalogId || state.item?.playParamsId || state.item?.id || '');
    // 队列驱动（playSong 带 ids）时 nowPlayingItem 会滞后于 queue.position，只看 item 会把
    // 已经生效的命令判成没生效。所以再看一眼 position 上的那一项。
    const atPosition = String(state.queue?.itemIds?.[state.queue?.position] || '');
    return state.isPlaying === true && (now === target || atPosition === target);
  }
  if (command === 'next' || command === 'previous') {
    const from = before?.item?.title || null;
    const to = state.item?.title || null;
    return Boolean(to) && to !== from;
  }
  return false;
}

/** 回读状态里只保留判定播控需要的字段。 */
export function summarizeControlState(state) {
  return {
    ready: !!state?.ready,
    isPlaying: !!state?.isPlaying,
    positionSec: state?.positionSec ?? null,
    title: state?.item?.title || null,
    artist: state?.item?.artist || null,
    queueLength: state?.queue?.length ?? null,
    queuePosition: state?.queue?.position ?? null,
    repeatMode: state?.repeatMode ?? null,
    shuffleMode: state?.shuffleMode ?? null,
    lastCommand: state?.lastCommand ?? null,
  };
}

/** 读 POST 的 JSON 体；超过 64KB 或不是 JSON 都直接失败，不猜。 */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (error) { reject(new Error(`不是合法 JSON: ${error.message}`)); }
    });
    req.on('error', reject);
  });
}

// —— 桥本体 ————————————————————————————————————————————————————————————
class AppleNowPlayingBridge {
  constructor() {
    this.cdp = null;
    this.helperReady = false;
    this.wsClients = new Set();
    this.track = null;          // 当前已推送的 Track（用于去重）
    this.lyric = null;          // 当前已推送的 Lyric
    this.lyricKey = null;       // 已取过歌词的曲目键，避免重复请求
    this.isPaused = true;
    this.lastProgressMs = 0;
    this.lastProgressAtMs = 0;
    this.lastProgressPushAtMs = 0;
    this.lastPositionSec = 0;
    this.lastPollAtMs = 0;
    this.lastError = null;
    this.lastControl = null;
    // 待播清单快照（只读）。队列不变就一直是这一份，变了由 refreshQueueSnapshot 重取并广播。
    this.queueSnapshot = null;
    this.queueSnapshotLoading = null;
    // 连续取不到待播清单就重连一次，避免连接假死后一直服务旧快照。
    this.queueRefreshFailures = 0;
    this.stats = { trackPushes: 0, lyricPushes: 0, lyricFetches: 0, progressPushes: 0, polls: 0, controls: 0 };
  }

  // —— 9863 服务 ——
  startServer() {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${BRIDGE_PORT}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');

      // 预检：Folia 页面在 localhost:3000，POST /api/control 带 Content-Type: application/json
      // 属跨源非简单请求，浏览器会先发 OPTIONS。不回这个 204，POST 根本到不了这里
      // （表现为「点了按钮什么都没发生」，连日志都没有）。
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/api/query/progress') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ progress: Math.floor(this.liveProgressMs()) }));
        return;
      }
      if (url.pathname === '/api/query/now-playing') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.buildTrackMessage() || {}));
        return;
      }
      if (url.pathname === '/api/control' && req.method === 'POST') {
        readJsonBody(req).then(async (body) => {
          const result = await this.applyControl(body?.command, body?.positionMs, body?.catalogId, body?.ids, body?.mode, body?.index);
          this.stats.controls += 1;
          this.lastControl = { command: body?.command ?? null, positionMs: body?.positionMs ?? null, catalogId: body?.catalogId ?? null, mode: body?.mode ?? null, ids: Array.isArray(body?.ids) ? body.ids.length : 0, index: Number.isFinite(Number(body?.index)) ? Number(body.index) : null, ok: Boolean(result.ok), applied: Boolean(result.applied) };
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          log(`播控 ${body?.command}${Array.isArray(body?.ids) && body.ids.length ? ' ids=' + body.ids.length : ''}${body?.catalogId ? ' id=' + body.catalogId : ''}${body?.mode ? ' mode=' + body.mode : ''} → ${result.ok ? (result.applied ? '已生效' : '已发出未生效') : '失败'}${result.error ? ` (${result.error})` : ''}${result.albumQueue ? ` [mode=${result.albumQueue.mode ?? '?'} count=${result.albumQueue.count ?? '?'}${result.albumQueue.fellBack ? ' 回退=' + result.albumQueue.fellBack : ''}${result.albumQueue.dropped ? ' 剔除=' + result.albumQueue.dropped : ''}]` : ''}`);
        }).catch((error) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
        });
        return;
      }
      if (url.pathname === '/api/query/queue') {
        // 待播清单的拉取版：WS 的 Queue 事件只在「连接建立」和「队列变化」时发，
        // 页面重载、桥重启、热更新都可能错过那一次，所以留一个能主动问的入口。
        const respond = () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: Boolean(this.queueSnapshot), queue: this.queueSnapshot }, null, 2));
        };
        if (this.queueSnapshot) { respond(); return; }
        this.refreshQueueSnapshot().then(respond).catch((error) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }));
        });
        return;
      }
      if (url.pathname === '/api/query/state') {   // 自加的状态页，Folia 不读，排查用
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          track: this.track, lyric: this.lyric, isPaused: this.isPaused,
          progressMs: Math.floor(this.liveProgressMs()), clients: this.wsClients.size,
          helperReady: this.helperReady, lastError: this.lastError, lastControl: this.lastControl, stats: this.stats,
        }, null, 2));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    const wss = new WebSocketServer({ server, path: '/api/ws/lyric' });
    wss.on('connection', (socket) => {
      this.wsClients.add(socket);
      log(`WS 客户端接入（当前 ${this.wsClients.size} 个）`);
      // 新客户端立刻拿到全量快照，否则要等下一次变化才有内容
      if (this.track) socket.send(JSON.stringify({ event: 'Track', data: this.buildTrackMessage() }));
      if (this.lyric) socket.send(JSON.stringify({ event: 'Lyric', data: this.buildLyricMessage() }));
      socket.send(JSON.stringify({
        event: 'PlayerProgress',
        data: { progress: Math.floor(this.liveProgressMs()) },
      }));
      socket.send(JSON.stringify({
        event: 'PlayerPauseState',
        data: this.buildPauseMessage(),
      }));
      // 待播清单整份快照。没有就现取一次（不阻塞后面的事件）。
      if (this.queueSnapshot) {
        socket.send(JSON.stringify({ event: 'Queue', data: this.queueSnapshot }));
      } else {
        void this.refreshQueueSnapshot();
      }
      socket.on('close', () => this.wsClients.delete(socket));
      socket.on('error', () => this.wsClients.delete(socket));
    });

    return new Promise((resolve) => server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      log(`9863 服务已就绪：ws://localhost:${BRIDGE_PORT}/api/ws/lyric`);
      resolve(server);
    }));
  }

  broadcast(event, data) {
    const text = JSON.stringify({ event, data });
    for (const client of this.wsClients) {
      if (client.readyState === 1) {
        try { client.send(text); } catch { this.wsClients.delete(client); }
      }
    }
  }

  // —— 消息构造 ——
  buildTrackMessage() {
    if (!this.track) return null;
    return {
      id: this.track.id,
      title: this.track.title || 'Now Playing',
      author: this.track.artist || 'Now Playing',
      album: this.track.album || '',
      cover: this.track.coverUrl || '',
      duration: this.track.durationMs || 0,   // ms；provider 侧 >10000 视为 ms
      // 循环 / 随机：MusicKit 用 none/one/all 与 off/songs，Folia 看到的是原样数值
      // （PlayerRepeatMode{none:0,one:1,all:2}、PlayerShuffleMode{off:0,songs:1}）。
      repeatMode: this.track.repeatMode ?? null,
      shuffleMode: this.track.shuffleMode ?? null,
      // 待播清单顺序（Apple 的真实顺序）。Folia 收到后按它重排自己的列表。
      queueItemIds: Array.isArray(this.track.queueItemIds) ? this.track.queueItemIds : [],
      // 目录 id：Folia 靠它认「换歌了」，再把标题/歌手/专辑/封面一起照过来。
      catalogId: this.track.catalogId ?? null,
    };
  }

  buildQueueMessage() {
    if (!this.queueSnapshot) return null;
    return this.queueSnapshot;
  }

  /**
   * 重取一次待播清单快照并广播。
   *
   * 只在队列内容真的变了时调用（换队列、随机重排、增删、切歌）。并发调用直接复用手上那次，
   * 免得 120ms 轮询发现连续变化时叠出好几次 80KB 的取数与广播。
   */
  async refreshQueueSnapshot() {
    if (this.queueSnapshotLoading) return this.queueSnapshotLoading;
    if (!this.cdp) return null;
    const pending = (async () => {
      let last = null;
      let consistent = null;
      // 换队列那一刻，页面的 queue 有时还没换完：只取一次会把旧队列钉死在缓存里
      // （表现就是拼贴墙一直显示上一份队列）。所以拿到后先跟 track.queueItemIds 对一遍，
      // 对不上就地重试；三次都不对就先用最后取到的那份，别让 UI 空着。
      for (let attempt = 0; attempt <= 2; attempt += 1) {
        try {
          const data = await this.cdp.evalJs(QUEUE_EXPR, { awaitPromise: false });
          if (!data?.ok || !Array.isArray(data.items)) {
            this.queueRefreshFailures += 1;
            log(`待播清单快照失败：${data?.error || '未知原因'}`);
            if (this.queueRefreshFailures >= 5) this.reconnectCdp('待播清单连续取不到');
            return;
          }
          last = {
            position: Number.isFinite(Number(data.position)) ? Number(data.position) : -1,
            items: data.items,
          };
          const expected = Array.isArray(this.track?.queueItemIds) ? this.track.queueItemIds : [];
          const fetched = last.items.map((item) => String(item?.id ?? ''));
          const matches = expected.length === 0
            || (fetched.length === expected.length && fetched.every((id, index) => id === expected[index]));
          if (matches) { consistent = last; break; }
          if (attempt < 2) await sleep(350);
        } catch (error) {
          this.queueRefreshFailures += 1;
          log(`待播清单快照异常：${error.message}`);
          if (this.queueRefreshFailures >= 5) this.reconnectCdp('待播清单快照连续异常');
          return;
        }
      }
      this.queueRefreshFailures = 0;
      const next = consistent || last;
      if (!next) return;
      if (!consistent) log(`待播清单与当前队列仍不一致（${next.items.length} 首），先用取到的这份`);
      const previous = this.queueSnapshot;
      this.queueSnapshot = next;
      // 队列本体大多数时候没变，逐首比对 id 再决定要不要推：
      // 变了才广播整份，没变就只在本机更新 position（省掉每秒 80KB 的无谓推送）。
      const sameItems = Boolean(previous)
        && previous.items.length === next.items.length
        && previous.items.every((item, index) => item.id === next.items[index]?.id);
      if (!sameItems) {
        this.broadcast('Queue', next);
        log(`待播清单已同步：${next.items.length} 首，当前第 ${next.position + 1} 首`);
      }
    })();
    // 关键：跑完必须把 loading 清掉，否则下一次调用会一直命中 early-return，
    // 快照就被钉死在第一次取到的那份（实测表现：曲目换了、待播清单永不更新）。
    this.queueSnapshotLoading = pending.finally(() => { this.queueSnapshotLoading = null; });
    return this.queueSnapshotLoading;
  }

  /** 丢掉当前 CDP 连接，让下一轮轮询重新抓页面（连接假死后唯一可靠的恢复手段）。 */
  reconnectCdp(reason) {
    log(`丢弃 CDP 连接（${reason}），下一轮重连`);
    try { this.cdp?.close(); } catch { /* ignore */ }
    this.cdp = null;
    this.helperReady = false;
  }

  buildLyricMessage() {
    if (!this.lyric) return null;    return {
      source: 'apple',
      title: this.lyric.title || '',
      author: this.lyric.artist || '',
      duration: this.lyric.durationMs || 0,
      hasLyric: !!this.lyric.lrc,
      hasTranslatedLyric: !!this.lyric.translatedLyric,
      hasKaraokeLyric: false,
      lrc: this.lyric.lrc || '',
      translatedLyric: this.lyric.translatedLyric || '',
      karaokeLyric: '',
    };
  }

  buildPauseMessage() {
    const durationMs = this.track?.durationMs || 0;
    const positionSec = this.liveProgressMs() / 1000;
    return {
      hasSong: !!this.track,
      isPaused: this.isPaused,
      seekbarCurrentPosition: positionSec,   // 秒；provider 按 <= 时长+1 判定
      statePercent: durationMs > 0 ? Math.min(1, (positionSec * 1000) / durationMs) : 0,
    };
  }

  /** 播放中用本地时钟外推，暂停时用最后一次锚点。 */
  liveProgressMs() {
    if (this.isPaused) return this.lastProgressMs;
    return this.lastProgressMs + (Date.now() - this.lastProgressAtMs);
  }

  // —— CDP ——
  async ensureCdp() {
    if (this.cdp) return true;
    try {
      this.cdp = await connect({ port: CDP_PORT, urlFilter: PAGE_MATCH });
      log(`已连接页面：${this.cdp.page.url}`);
      this.helperReady = false;
      return true;
    } catch (error) {
      this.lastError = `CDP 连接失败: ${error.message}`;
      this.cdp = null;
      return false;
    }
  }

  /** 解冻页面。隐藏/冻结的标签页收不到 fetch 回调，取歌词前必须调一次。 */
  async wakePage() {
    if (!this.cdp) return;
    try { await this.cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch { /* 老版本不支持就算了 */ }
    // 播放期间不再调 Page.bringToFront：那会把专用浏览器窗口弹到最前，用户在 Folia 里
    // 点一次卡片就被打断一次。改用「让页面以为自己在前台」：
    //   - setFocusEmulationEnabled：焦点仿真，MusicKit 认为窗口是激活的；
    //   - 配合专用浏览器启动参数里的 --disable-renderer-backgrounding /
    //     --disable-background-timer-throttling / --disable-backgrounding-occluded-windows /
    //     CalculateNativeWinOcclusion 关闭，最小化或被他窗口遮挡时渲染与计时器不被节流。
    // 若某天实测最小化后播放仍停住，说明 Apple 改了可见性判定，这里再退回 bringToFront。
    try { await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch { /* 老版本不支持就只靠启动参数 */ }
  }

  /**
   * 施加一条播控命令：先解冻 → 发命令（不 await）→ 读状态验证。
   *
   * 为什么不信任命令的返回值：冻结页里的命令 promise 会一直 pending，解冻后才回放。
   * 若把「pending」当失败，就会出现「Folia 说没成功、音乐稍后自己响了」的状态错位；
   * 若 fire-and-forget 就报成功，又是另一种谎。唯一诚实的判据是回读 MusicKit 状态。
   *
   * @param {string} command play | pause | next | previous | seek
   * @param {number} [positionMs] seek 的目标位置（毫秒）
   * @returns {Promise<{ok:boolean, command?:string, dispatched?:boolean, applied?:boolean, state?:object|null, note?:string, error?:string}>}
   */
  async applyControl(command, positionMs, catalogId, ids, mode, index) {
    if (typeof command !== 'string' || !command) return { ok: false, error: '缺少 command' };
    // 分段计时：用户报「点播放要等十秒」时，得能分清慢在连页面、解冻/前置窗口、读状态还是页面自己建队列。
    const tRequest = Date.now();
    if (!(await this.ensureCdp())) return { ok: false, error: 'CDP 未连接（找不到 music.apple.com 页面）' };
    const tConnect = Date.now();
    await this.wakePage();
    const tWake = Date.now();

    const before = await this.pollOnce();          // 换曲类命令要靠它做前后对比
    const tBeforePoll = Date.now();
    const positionSec = Number(positionMs) > 0 ? Number(positionMs) / 1000 : 0;

    let dispatch = null;
    try {
      // awaitPromise 显式关掉：冻结时这个 promise 不 settle，等它就是 hang 住
      dispatch = await this.cdp.evalJs(CONTROL_EXPR(command, positionSec, catalogId, ids, mode, index), { awaitPromise: false });
    } catch (error) {
      return { ok: false, command, error: `命令下发失败: ${error.message}` };
    }
    if (!dispatch?.ok) return { ok: false, command, error: dispatch?.error || '命令被页面拒绝' };

    // 回读验证：最多等 8 秒看命令是否真的落地。
    // 为什么不是 1.6 秒：命令是下给一个**可能被冻结**的标签页的，冻结期间 MusicKit 的
    // promise 会排队，等页面真正可见才开始回放。实测点名播放（playSong）要 ~5 秒才反映到
    // 状态里，1.6 秒的窗口会把已经生效的命令误判成「没生效」——正是这个假阴性。
    // 窗口内继续周期性解冻：页面越早真正可见，命令越早回放，不必等满。
    // 大队列（几百首）的 setQueue 要逐首解析 catalogId，实测 477 首要 10s 以上。
    // 固定 8 秒会把「正在建队列」误判成「没生效」，所以按队列长度放宽，上限 30 秒。
    const windowMs = Math.min(30000, 8000 + Math.max(0, (Array.isArray(ids) ? ids.length : 0) - 20) * 40);
    const startedAt = Date.now();
    const deadline = startedAt + windowMs;
    if (tBeforePoll - tRequest > 300) {
      log(`播控前置耗时 ${command}：连页面 ${tConnect - tRequest}ms，解冻/前置 ${tWake - tConnect}ms，读状态 ${tBeforePoll - tWake}ms`);
    }
    let state = null;
    let waited = 0;
    for (;;) {
      state = await this.pollOnce();
      if (commandSatisfied(command, positionSec, state, before, catalogId, mode, index)) {
        log(`播控 ${command} 生效，用时 ${Math.round((Date.now() - startedAt) / 100) / 10}s`);
        return { ok: true, command, dispatched: true, applied: true, state: summarizeControlState(state) };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
      waited += 1;
      if (waited % 5 === 0) await this.wakePage();   // 约每秒再解冻一次
    }
    log(`播控 ${command} 超时未生效（等了 ${Math.round((Date.now() - startedAt) / 100) / 10}s，窗口 ${windowMs}ms）`);
    return {
      ok: true,
      command,
      dispatched: true,
      applied: false,
      state: state ? summarizeControlState(state) : null,
      note: '命令已发出但状态未在 8s 内改变（页面被冻住时命令会排队，解冻后才回放）',
    };
  }

  async ensureHelper() {
    if (!this.cdp) return false;
    if (this.helperReady) {
      const alive = await this.cdp.evalJs('!!(window.__NP && window.__NP.get)');
      if (alive === true) return true;
      this.helperReady = false;
    }
    const result = await this.cdp.evalJs(INSTALL_EXPR);
    if (result?.ok) {
      this.helperReady = true;
      return true;
    }
    this.lastError = `页面助手注入失败: ${result?.error || '未知'}`;
    return false;
  }

  /** 轮询一次播放状态；返回 null 表示这次读失败。 */
  async pollOnce() {
    if (!(await this.ensureCdp())) return null;
    let state;
    try {
      state = await this.cdp.evalJs(STATE_EXPR);
    } catch (error) {
      log(`求值失败，准备重连：${error.message}`);
      try { this.cdp.close(); } catch { /* ignore */ }
      this.cdp = null;
      return null;
    }
    if (state?.__exc) { this.lastError = `页面求值异常: ${state.__exc}`; return null; }
    this.stats.polls += 1;
    return state;
  }

  /** 取当前曲目的歌词并转成 LRC。 */
  async fetchLyrics(track) {
    this.stats.lyricFetches += 1;
    await this.wakePage();
    if (!(await this.ensureHelper())) return null;

    const storefront = this.storefront || 'cn';
    const path = `/v1/catalog/${storefront}/songs/${encodeURIComponent(track.lyricId)}/lyrics`;

    let response;
    try {
      response = await this.cdp.evalJs(
        `window.__NP.get(${JSON.stringify(path)})`,
        { awaitPromise: true },
      );
    } catch (error) {
      log(`歌词请求失败（${track.title}）：${error.message}`);
      return null;
    }

    if (response?.__exc) { log(`歌词求值异常：${response.__exc}`); return null; }

    if (!response?.ok) {
      // 库内曲目常常没有目录 id，404 属正常，不当成错误
      if (response?.status === 404) log(`歌词 404（${track.title}）：该曲目没有目录歌词`);
      else log(`歌词 HTTP ${response?.status}（${track.title}）`);
      return null;
    }

    const ttml = response?.json?.data?.[0]?.attributes?.ttml || '';
    const converted = ttmlToLrc(ttml);
    if (!converted) {
      log(`歌词无法转换（${track.title}）：ttml 长度 ${ttml.length}`);
      return null;
    }
    log(`歌词已转换（${track.title}）：${converted.lineCount} 行${converted.translatedLyric ? ' + 翻译' : ''}`);
    return {
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
      lrc: converted.lrc,
      translatedLyric: converted.translatedLyric,
    };
  }

  /** 处理一次状态快照：曲目变化 → 推 Track/Lyric；进度/暂停变化 → 推进度与状态。 */
  async handleState(state) {
    if (!state?.ready) return;
    this.storefront = state.storefront || this.storefront;

    const item = state.item;
    const trackId = item?.id || null;
    const prevId = this.track?.id || null;

    if (!item) {
      if (this.track) {
        log('播放停止：清空曲目');
        this.track = null;
        this.lyric = null;
        this.lyricKey = null;
        this.isPaused = true;
        this.lastProgressMs = 0;
        this.broadcast('Track', {});
        this.broadcast('PlayerPauseState', this.buildPauseMessage());
      }
      return;
    }

    const nowPlaying = {
      id: String(trackId),
      title: item.title || '',
      artist: item.artist || '',
      album: item.album || '',
      coverUrl: resolveArtworkUrl(item.artworkUrl),
      durationMs: item.durationMs || 0,
      // 取歌词要用目录 id：playParams.catalogId 优先，其次纯数字的 playParams.id
      lyricId: item.catalogId
        || (/^\d+$/.test(String(item.playParamsId || '')) ? String(item.playParamsId) : null),
      // 目录 id 单独给一份：Folia 用它判断「这首歌是不是已经换过了」，并据此重建自己的
      // 当前曲目对象——标题/歌手/专辑/封面都跟着外部播放器走，而不是停在点歌那一刻。
      catalogId: item.catalogId ? String(item.catalogId) : null,
      hasLyrics: !!item.hasLyrics,
      // 循环 / 随机：这两个是**播放器状态**而不是曲目属性，但和曲目一起发给 Folia 最省事——
      // 它那边的循环/随机按钮要跟着外部播放器变（双向同步）。
      repeatMode: state.repeatMode,
      shuffleMode: state.shuffleMode,
      // 待播清单的曲目 id 顺序：Apple 一开随机就自己重排，Folia 要靠它把列表拉齐。
      queueItemIds: Array.isArray(state.queue?.itemIds) ? state.queue.itemIds : [],
    };

    const trackChanged = nowPlaying.id !== prevId
      || nowPlaying.title !== (this.track?.title || '')
      || nowPlaying.coverUrl !== (this.track?.coverUrl || '');

    if (trackChanged) {
      this.track = nowPlaying;
      this.stats.trackPushes += 1;
      log(`曲目：${nowPlaying.title} — ${nowPlaying.artist}（${Math.round(nowPlaying.durationMs / 1000)}s）`);
      this.broadcast('Track', this.buildTrackMessage());

      // 换曲后先清掉上一首的歌词，避免短暂显示错词
      this.lyric = null;
      this.lyricKey = null;
      this.broadcast('Lyric', { hasLyric: false, lrc: '' });

      if (nowPlaying.hasLyrics && nowPlaying.lyricId) {
        const fetched = await this.fetchLyrics(nowPlaying);
        if (fetched && this.track?.id === nowPlaying.id) {
          this.lyric = fetched;
          this.lyricKey = nowPlaying.id;
          this.stats.lyricPushes += 1;
          this.broadcast('Lyric', this.buildLyricMessage());
        }
      } else if (nowPlaying.hasLyrics && !nowPlaying.lyricId) {
        log(`曲目无目录 id，跳过歌词：${nowPlaying.title}`);
      }

      // 换曲时进度重置到当前实际位置
      this.lastProgressMs = Math.max(0, Math.round((state.positionSec || 0) * 1000));
      this.lastProgressAtMs = Date.now();
    } else {
      // 循环 / 随机变了但没换曲：单独重发一次 Track，否则 Folia 的按钮会一直停在旧档位。
      // 只重发 Track，不动歌词那一串。
      const modeChanged = state.repeatMode !== this.track?.repeatMode
        || state.shuffleMode !== this.track?.shuffleMode;
      // 随机一拨，Apple 只管重排自己的队列、曲目没换 —— 这时也要重发 Track，
      // 否则 Folia 的待播清单永远停在旧顺序，两边「下一首」对不上。
      const nextQueueIds = Array.isArray(state.queue?.itemIds) ? state.queue.itemIds : [];
      const prevQueueIds = Array.isArray(this.track?.queueItemIds) ? this.track.queueItemIds : [];
      const queueChanged = nextQueueIds.length !== prevQueueIds.length
        || nextQueueIds.some((id, index) => id !== prevQueueIds[index]);
      if (modeChanged || queueChanged) {
        this.track = {
          ...this.track,
          repeatMode: state.repeatMode,
          shuffleMode: state.shuffleMode,
          queueItemIds: nextQueueIds,
        };
        log(`${modeChanged ? `模式：循环=${state.repeatMode} 随机=${state.shuffleMode} ` : ''}${queueChanged ? `队列顺序变了（${nextQueueIds.length} 首）` : ''}`.trim());
        this.broadcast('Track', this.buildTrackMessage());
        // 队列变了才去重取整份清单（80KB 量级，不能跟着 120ms 轮询跑）。
        if (queueChanged) void this.refreshQueueSnapshot();
      }
    }

    const positionMs = Math.max(0, Math.round((state.positionSec || 0) * 1000));
    const wasPaused = this.isPaused;
    this.isPaused = !state.isPlaying;

    // 拖动/跳转检测：与按时间外推的预期位置差得远，就当成 seek
    const expectedMs = wasPaused
      ? this.lastProgressMs
      : this.lastProgressMs + (Date.now() - this.lastProgressAtMs);
    const seeked = !trackChanged && Math.abs(positionMs - expectedMs) > 1500;
    const pauseChanged = wasPaused !== this.isPaused;

    if (pauseChanged || seeked) {
      // 先发精确进度，再发暂停状态：provider 会用 5 秒内的精确进度覆盖暂停消息里的进度
      this.lastProgressMs = positionMs;
      this.lastProgressAtMs = Date.now();
      this.stats.progressPushes += 1;
      this.broadcast('PlayerProgress', { progress: positionMs });
      this.broadcast('PlayerPauseState', this.buildPauseMessage());
      log(`${this.isPaused ? '暂停' : '继续'}${seeked ? '（跳转）' : ''} @ ${(positionMs / 1000).toFixed(1)}s`);
      return;
    }

    if (!this.isPaused) {
      // 播放中按固定节奏推精确进度
      this.lastProgressMs = positionMs;
      this.lastProgressAtMs = Date.now();
      if (Date.now() - this.lastProgressPushAtMs >= PROGRESS_PUSH_MS) {
        this.lastProgressPushAtMs = Date.now();
        this.stats.progressPushes += 1;
        this.broadcast('PlayerProgress', { progress: positionMs });
      }
    }
  }

  async run() {
    await this.startServer();
    if (ONCE) {
      const state = await this.pollOnce();
      console.log('\n=== 当前快照 ===');
      console.log(JSON.stringify(state, null, 2));
      if (state?.item?.hasLyrics) {
        const item = state.item;
        const lyricId = item.catalogId
          || (/^\d+$/.test(String(item.playParamsId || '')) ? String(item.playParamsId) : null);
        if (lyricId) {
          const fetched = await this.fetchLyrics({
            id: String(item.id), title: item.title, artist: item.artist,
            durationMs: item.durationMs || 0, lyricId,
          });
          console.log('\n=== LRC 前 12 行 ===');
          console.log(fetched ? fetched.lrc.split('\n').slice(0, 12).join('\n') : '(无)');
        }
      }
      try { this.cdp?.close(); } catch { /* ignore */ }
      process.exit(0);
    }

    log(`桥已启动：轮询 ${POLL_MS}ms，待播清单 ${QUEUE_REFRESH_MS}ms，页面匹配 "${PAGE_MATCH}"`);
    let lastQueueRefreshAtMs = 0;
    for (;;) {
      try {
        const state = await this.pollOnce();
        if (state) await this.handleState(state);
        // 待播清单整份重取：跟着主循环跑，但要等上一份取完（内部有 queueSnapshotLoading 去重），
        // 没取完就跳过这一轮，不排队。
        if (Date.now() - lastQueueRefreshAtMs >= QUEUE_REFRESH_MS && !this.queueSnapshotLoading) {
          lastQueueRefreshAtMs = Date.now();
          void this.refreshQueueSnapshot();
        }
      } catch (error) {
        this.lastError = error.message;
        log(`循环出错（继续跑）：${error.message}`);
      }
      await sleep(POLL_MS);
    }
  }
}

const bridge = new AppleNowPlayingBridge();

// 只有被当作入口脚本时才起桥；被 import 时（例如跑 ttmlToLrc 的单测）不产生副作用
const isEntry = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  bridge.run().catch((error) => {
    console.error('桥启动失败：', error);
    process.exit(1);
  });
}

export { AppleNowPlayingBridge };
