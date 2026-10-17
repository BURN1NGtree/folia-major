const http = require('node:http');
const WebSocket = require('ws');

// electron/appleMusicBridge.cjs

/**
 * Apple Music 桥 —— 主进程侧唯一接触 Apple Music 的地方。
 *
 * 设计要点（全部来自实测，不是推断）：
 *
 * 1. **本桥只读。** `APPLE_OPERATIONS` 是白名单，且每一项都只发 GET。
 *    绝不写用户的 Apple 账号 —— 这是与前作共享的安全边界。
 * 2. **不在主进程里直连 amp-api。** Apple 要求 `Authorization: Bearer <developerToken>`
 *    外加 `media-user-token`，而这两个令牌只存在于已登录页面的 JS 上下文里
 *    （`MusicKit.getInstance().developerToken` / `.musicUserToken`）。
 *    因此真正的 fetch 发生在**页面上下文**，主进程只负责搬运。
 *    这也顺带避开了 CORS 与令牌存储问题。
 * 3. **不改 asar、不注入页面。** 走标准 CDP（`Runtime.evaluate`），
 *    附着到用户自己的专用浏览器实例上，浏览器关掉桥就失效 —— 可复现、可回滚。
 * 4. **不手工设 `Origin`。** 实测：手工设会与浏览器自动值冲突；浏览器自己会设成
 *    `https://music.apple.com`，正确的那一个就是它。
 */

/** 默认 CDP 端点。用户可以自己在 9222 上开一个专用浏览器（本轮采用的方式）。 */
const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';

/** 只认这个来源的页面，避免误附到别的标签页上。 */
const APPLE_MUSIC_PAGE_PREFIX = 'https://music.apple.com';

const AMP_API_HOST = 'https://amp-api.music.apple.com';

/** 单次 CDP 往返的上限；页面卡死时不能让整个请求永久挂着。 */
const CDP_TIMEOUT_MS = 15000;

/** 令牌与助手状态的缓存时长。开发者令牌按小时轮换，一分钟级缓存足够省掉重复注入。 */
const HELPER_TTL_MS = 60_000;

/**
 * 只读操作白名单。键是暴露给渲染层的操作名，值是「参数 → amp-api 路径」的构造函数。
 *
 * 新增操作时必须先问：它会不会写用户账号？会写的一律不进这张表。
 * 播放控制（play/pause/skip）属于第 3 步，本轮刻意不在这里。
 */
const APPLE_OPERATION_PATHS = Object.freeze({
    // —— 会话与连通性 ——
    session: () => null,   // 不需要打网络，只是把页面侧助手状态读出来
    ping: () => null,

    // —— 用户曲库（只读）——
    library_playlists: p => `/v1/me/library/playlists${pageQuery(p)}`,
    library_playlist_detail: p => `/v1/me/library/playlists/${mediaId(p.id)}`,
    library_playlist_tracks: p => `/v1/me/library/playlists/${mediaId(p.id)}/tracks${pageQuery(p)}`,
    library_songs: p => `/v1/me/library/songs${pageQuery(p)}`,
    library_albums: p => `/v1/me/library/albums${pageQuery(p)}`,
    library_album_detail: p => `/v1/me/library/albums/${mediaId(p.id)}`,
    library_album_tracks: p => `/v1/me/library/albums/${mediaId(p.id)}/tracks${pageQuery(p)}`,
    library_artists: p => `/v1/me/library/artists${pageQuery(p)}`,
    recent_played: p => `/v1/me/recent/played${pageQuery(p)}`,
    // 个性化首页：Apple 把「专属推荐歌单」「专属电台推荐」等分组都塞在这一个响应里，
    // 分组标题在 attributes.title（中文站就是「专属推荐歌单」），成员在 relationships.contents。
    // 只读 GET，和曲库那几条同一套鉴权。
    me_recommendations: p => `/v1/me/recommendations${pageQuery(p)}`,

    // —— 目录（storefront 作用域，只读）——
    catalog_search: p => `/v1/catalog/${storefront(p)}/search${searchQuery(p)}`,
    catalog_song: p => `/v1/catalog/${storefront(p)}/songs/${mediaId(p.id)}${includeQuery(p)}`,
    catalog_album: p => `/v1/catalog/${storefront(p)}/albums/${mediaId(p.id)}${includeQuery(p)}`,
    catalog_artist: p => `/v1/catalog/${storefront(p)}/artists/${mediaId(p.id)}${includeQuery(p)}`,
    // 推荐歌单（`pl.pm-` 前缀，来自 me/recommendations 的「专属推荐歌单」）不在曲库里，
    // `/v1/me/library/playlists/{id}/tracks` 对它一律 404；它们只有目录侧这条路径。
    catalog_playlist: p => `/v1/catalog/${storefront(p)}/playlists/${mediaId(p.id)}${includeQuery(p)}`,
    catalog_playlist_tracks: p => `/v1/catalog/${storefront(p)}/playlists/${mediaId(p.id)}/tracks${pageQuery(p)}`,
    // 歌词只认**目录 id**（纯数字）；实测库内 id（`i.` 前缀）在这个端点上是 404。
    song_lyrics: p => `/v1/catalog/${storefront(p)}/songs/${mediaId(p.id)}/lyrics`,
});

const APPLE_OPERATIONS = Object.freeze(Object.keys(APPLE_OPERATION_PATHS));

/** Apple 的分页上限就是 100；超过会被截断，不如由我们统一压到 100。 */
const MAX_PAGE_LIMIT = 100;

function clampLimit(value, fallback = MAX_PAGE_LIMIT) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(Math.floor(parsed), MAX_PAGE_LIMIT);
}

function clampOffset(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
}

function pageQuery(params) {
    return `?limit=${clampLimit(params.limit)}&offset=${clampOffset(params.offset)}`;
}

function searchQuery(params) {
    const term = String(params.term ?? params.query ?? '').trim();
    if (!term) throw new Error('Apple Music search needs a non-empty term');
    const types = Array.isArray(params.types) && params.types.length > 0
        ? params.types.map(type => String(type)).join(',')
        : 'songs,albums,artists,playlists';
    return `?term=${encodeURIComponent(term)}&types=${encodeURIComponent(types)}`
        + `&limit=${clampLimit(params.limit, 25)}&offset=${clampOffset(params.offset)}`;
}

function includeQuery(params) {
    if (!Array.isArray(params.include) || params.include.length === 0) return '';
    return `?include=${encodeURIComponent(params.include.map(String).join(','))}`;
}

/** storefront 只允许两字母地区码，防止把参数拼进路径里。 */
function storefront(params) {
    const value = String(params.storefront ?? 'cn').toLowerCase();
    return /^[a-z]{2}$/.test(value) ? value : 'cn';
}

/** 媒体 id 直接进路径，必须编码；空 id 是调用方的错，不能放行成 `//tracks`。 */
function mediaId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) throw new Error('Apple Music operation needs a media id');
    return encodeURIComponent(raw);
}

/**
 * 页面侧助手：把两个令牌和统一 fetch 装进 `window.__AM`。
 *
 * 为什么必须是同步 IIFE：CDP 的 `Runtime.evaluate` 在 `awaitPromise:false` 下直接取返回值，
 * 注入本身不需要异步；只有后续的 `get()` 才需要 await。
 */
const INSTALL_HELPER = `
(() => {
  const mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
  if (!mk) return { ok: false, error: 'MusicKit 未就绪' };
  // 未登录时 musicUserToken 是 undefined：这里必须兜底成空串，否则下面取
  // .length 会抛异常，调用方只能拿到一个没有信息的 'Uncaught'。
  window.__AM = {
    tok: mk.developerToken || '',
    usr: mk.musicUserToken || '',
    sf: mk.storefrontId || 'cn',
    auth: Boolean(mk.isAuthorized),
    async get(path) {
      const r = await fetch(${JSON.stringify(AMP_API_HOST)} + path, {
        headers: {
          'Authorization': 'Bearer ' + window.__AM.tok,
          'media-user-token': window.__AM.usr,
        },
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {
        status: r.status,
        ok: r.ok,
        json,
        // 非 JSON 响应（例如 403 的 HTML 错误页）保留前 200 字符便于诊断
        text: json ? null : text.slice(0, 200),
      };
    },
  };
  return { ok: true, auth: window.__AM.auth, sf: window.__AM.sf,
           tokLen: window.__AM.tok.length, usrLen: window.__AM.usr.length };
})()
`;

/** CDP 的最小 HTTP 客户端：只用来取 `/json/list`。用 node:http 而不是 fetch，避免对运行时全局的假设。 */
function listTargets(endpoint) {
    return new Promise((resolve, reject) => {
        const request = http.get(`${endpoint}/json/list`, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    if (!Array.isArray(parsed)) reject(new Error('CDP target list is not an array'));
                    else resolve(parsed);
                } catch (error) {
                    reject(new Error(`CDP target list is not JSON: ${error.message}`));
                }
            });
        });
        request.on('error', reject);
        request.setTimeout(3000, () => request.destroy(new Error('CDP endpoint timed out')));
    });
}

/** 一条 CDP 连接。只管 request/response 配对与生命周期，不懂 Apple Music。 */
class CdpConnection {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        this.closed = false;
        socket.on('message', raw => {
            let message;
            try { message = JSON.parse(String(raw)); } catch { return; }
            const resolver = this.pending.get(message.id);
            if (!resolver) return;
            this.pending.delete(message.id);
            if (message.error) resolver.reject(new Error(message.error.message || 'CDP error'));
            else resolver.resolve(message.result);
        });
        const fail = reason => {
            this.closed = true;
            this.pending.forEach(resolver => resolver.reject(reason));
            this.pending.clear();
        };
        socket.on('close', () => fail(new Error('CDP connection closed')));
        socket.on('error', error => fail(error));
    }

    static open(webSocketUrl) {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(webSocketUrl);
            const onError = error => { socket.terminate(); reject(error); };
            socket.once('error', onError);
            socket.once('open', () => {
                socket.off('error', onError);
                resolve(new CdpConnection(socket));
            });
        });
    }

    send(method, params = {}) {
        if (this.closed) return Promise.reject(new Error('CDP connection is closed'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP ${method} timed out`));
            }, CDP_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    /**
     * 在页面里求值。`returnByValue` 才能把对象带回主进程；
     * 页面抛错时 CDP 不报 error 而是给 exceptionDetails，必须显式翻成异常。
     */
    async evaluate(expression, { awaitPromise = false } = {}) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text || 'Page evaluation failed');
        }
        return result.result ? result.result.value : undefined;
    }

    close() {
        this.closed = true;
        try { this.socket.close(); } catch { /* 关不掉也不影响主流程 */ }
    }
}

/** 找到已登录的 Apple Music 页面。找不到就要给出「端点可达但没有目标页」的可区分证据。 */
function pickAppleMusicTarget(targets) {
    const pages = targets.filter(target => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string');
    const apple = pages.find(target => typeof target.url === 'string' && target.url.startsWith(APPLE_MUSIC_PAGE_PREFIX));
    if (apple) return apple;
    const summary = pages.slice(0, 5).map(target => String(target.url || '').slice(0, 80)).join(' | ');
    const error = new Error(`CDP 端点上没有 ${APPLE_MUSIC_PAGE_PREFIX} 的页面。当前页面: ${summary || '(无)'}`);
    error.code = 'no-apple-target';
    return error;
}

/** 建立到 Apple Music 页面的连接。这段是桥里唯一碰真实浏览器的地方，单测通过注入替换它。 */
async function connectToAppleMusicPage(endpoint) {
    const targets = await listTargets(endpoint);
    const target = pickAppleMusicTarget(targets);
    const connection = await CdpConnection.open(target.webSocketDebuggerUrl);
    await connection.send('Runtime.enable');
    // Page 域用于下面的解冻；顺带让页面事件可见。
    await connection.send('Page.enable');
    return connection;
}

/**
 * 与 `pickAppleMusicTarget` 同一套规则，但**不抛错**：返回命中的页面或 null。
 *
 * 浏览器模块要用它决定「复用现有标签页」还是「新开一个」——那里把「没有目标页」
 * 当成正常分支，而不是异常。
 */
function pickAppleMusicTargetWithDetails(targets) {
    if (!Array.isArray(targets)) return null;
    return targets.find(target => (
        target
        && target.type === 'page'
        && typeof target.webSocketDebuggerUrl === 'string'
        && typeof target.url === 'string'
        && target.url.startsWith(APPLE_MUSIC_PAGE_PREFIX)
    )) || null;
}

/**
 * 让页面保持「活」的任务队列。
 *
 * 实测（本机 Edge 155 / music.apple.com）：后台标签页会被 Chromium 冻结，冻结后
 * **所有** fetch/XHR 的 promise 永远不 settle —— 连同源请求也一样 —— 而
 * `Runtime.evaluate` 的同步求值照常工作。于是故障表现成「静默超时」，
 * 看起来像网络问题或令牌过期，其实只是回调投递不了。
 *
 * `Page.setWebLifecycleState({state:'active'})` 能解冻任务队列，且实测
 * `document.visibilityState` 仍为 `hidden` —— 也就是说**不会抢用户焦点**。
 * 冻结点会随时间重新出现，所以每次取数前都刷一次；代价是一次本地 CDP 往返。
 * 老引擎若没有这条命令则退化为「需要用户把窗口留在前台」，不静默失败。
 */
async function keepPageAwake(connection) {
    try {
        await connection.send('Page.setWebLifecycleState', { state: 'active' });
    } catch { /* 命令不存在：交给上层超时报错，这里不掩盖 */ }
}

function ok(data) { return { ok: true, data }; }

/**
 * 把页面侧 `{status, ok, json, text}` 翻成桥的信封。
 * 状态码映射用的是本项目的 error code 词表，不另造一套。
 */
function toEnvelope(operation, response) {
    if (!response || typeof response !== 'object') {
        return { ok: false, error: { code: 'invalid-response', message: `Apple Music ${operation} returned no response` } };
    }
    if (response.ok) {
        if (response.json === null || response.json === undefined) {
            return { ok: false, error: { code: 'invalid-response', message: `Apple Music ${operation} returned a non-JSON body`, text: response.text } };
        }
        return ok(response.json);
    }
    const status = Number(response.status) || 0;
    const code = status === 401 || status === 403 ? 'auth-required'
        : status === 404 ? 'unsupported'
            : status === 429 ? 'rate-limited'
                : status >= 500 ? 'service-unavailable'
                    : 'invalid-response';
    return {
        ok: false,
        error: {
            code,
            message: `Apple Music ${operation} failed with HTTP ${status}`,
            httpStatus: status,
            ...(response.text ? { text: response.text } : {}),
        },
    };
}

/**
 * 建桥。
 *
 * @param {object} options
 * @param {string} [options.endpoint]  CDP 端点，默认 9222
 * @param {Function} [options.connect] 连接工厂，单测注入用；默认连真实浏览器
 * @param {Function} [options.now]     时间源，单测注入用
 * @param {Function} [options.warn]    非致命异常出口
 */
function createAppleMusicBridge({
    endpoint = DEFAULT_CDP_ENDPOINT,
    connect = () => connectToAppleMusicPage(endpoint),
    now = Date.now,
    warn = console.warn,
} = {}) {
    let connection = null;
    let connecting = null;
    let helper = null;

    const dropConnection = () => {
        if (connection) {
            try { connection.close(); } catch { /* 已经断了 */ }
        }
        connection = null;
        helper = null;
    };

    /** 复用在途连接：两个并发请求不该开出两条 CDP 连接。 */
    const getConnection = async () => {
        if (connection && !connection.closed) return connection;
        if (!connecting) {
            connecting = connect().then(
                value => { connection = value; connecting = null; return value; },
                error => { connecting = null; dropConnection(); throw error; },
            );
        }
        return connecting;
    };

    /**
     * 注入页面助手并缓存。页面导航会清掉 `window.__AM`，所以缓存带 TTL，
     * 且调用方在拿到「MusicKit 未就绪」时会强制重注入一次。
     */
    const ensureHelper = async (conn, force = false) => {
        if (!force && helper && now() - helper.at < HELPER_TTL_MS) return helper.state;
        const state = await conn.evaluate(INSTALL_HELPER);
        if (!state || state.ok !== true) {
            const error = new Error(state && state.error ? state.error : 'Apple Music 助手注入失败');
            error.code = 'helper-unavailable';
            throw error;
        }
        helper = { at: now(), state };
        return state;
    };

    /** 页面侧取数。`__AM` 不存在说明页面刚导航过，重注入后只重试一次。 */
    const pageGet = async (conn, path) => {
        await keepPageAwake(conn);
        await ensureHelper(conn);
        const expression = `window.__AM && window.__AM.get(${JSON.stringify(path)})`;
        let response = await conn.evaluate(expression, { awaitPromise: true });
        if (response === undefined || response === null) {
            await ensureHelper(conn, true);
            response = await conn.evaluate(expression, { awaitPromise: true });
        }
        return response;
    };

    return {
        /** 只读操作白名单，供渲染层与测试断言。 */
        operations: APPLE_OPERATIONS,
        endpoint,

        async request(operation, params = {}) {
            // 必须用 own-property 判定：直接下标会命中 `Object.prototype.constructor`
            // / `toString` / `valueOf` 这类继承键，等于白名单形同虚设。
            if (!Object.hasOwn(APPLE_OPERATION_PATHS, operation)) {
                return { ok: false, error: { code: 'unsupported', message: `Unsupported Apple Music operation: ${operation}` } };
            }
            const buildPath = APPLE_OPERATION_PATHS[operation];

            let path;
            try {
                path = buildPath(params || {});
            } catch (error) {
                return { ok: false, error: { code: 'unsupported', message: error.message } };
            }

            let conn;
            try {
                conn = await getConnection();
            } catch (error) {
                // 浏览器没开 / 端口不对 / 没有 Apple Music 页面：三种都归为「桥不可用」。
                // 重试可能变好（用户去开浏览器），所以 transient 由上层决定，这里只给证据。
                return {
                    ok: false,
                    error: {
                        code: 'unavailable',
                        message: 'Apple Music 浏览器不可达',
                        detail: error.message,
                        reason: error.code || 'connect-failed',
                    },
                };
            }

            try {
                if (operation === 'ping') {
                    return ok({ endpoint, target: true, helper: helper ? helper.state : null });
                }
                if (operation === 'session') {
                    return ok(await ensureHelper(conn));
                }
                return toEnvelope(operation, await pageGet(conn, path));
            } catch (error) {
                // 连接在请求中途断掉：丢掉缓存，让下一次请求重新连。
                warn(`[apple-music] ${operation} failed:`, error.message);
                dropConnection();
                return {
                    ok: false,
                    error: {
                        code: error.code === 'helper-unavailable' ? 'auth-required' : 'network',
                        message: `Apple Music ${operation} failed`,
                        detail: error.message,
                    },
                };
            }
        },

        dispose() {
            dropConnection();
        },
    };
}

module.exports = {
    APPLE_OPERATIONS,
    APPLE_OPERATION_PATHS,
    DEFAULT_CDP_ENDPOINT,
    APPLE_MUSIC_PAGE_PREFIX,
    createAppleMusicBridge,
    // 下面几个导出只为单测：路径构造与状态码映射是纯函数，值得单独覆盖。
    clampLimit,
    toEnvelope,
    pickAppleMusicTarget,
    // 浏览器侧复用：登录引导窗口要自己连同一条 CDP，不该再抄一份协议实现。
    listTargets,
    CdpConnection,
    pickAppleMusicTargetWithDetails,
};
