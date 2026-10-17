const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listTargets, CdpConnection, pickAppleMusicTargetWithDetails, DEFAULT_CDP_ENDPOINT, APPLE_MUSIC_PAGE_PREFIX } = require('./appleMusicBridge.cjs');

// electron/appleMusicBrowser.cjs

/**
 * Apple Music 专用浏览器的**生命周期**部分：拉起、探测、聚焦、最小化、清会话。
 *
 * 与 `appleMusicBridge.cjs` 的分工：
 * - 桥只负责「已经有一个登录好的页面时，把数据搬回来」；
 * - 本模块负责「页面不存在时，把那个页面弄出来」。
 *
 * 安全边界（与桥一致，不放宽）：
 * 1. **只启动、不代填。** 这里绝不 sendKeys、绝不读页面上的输入框。
 *    账号、密码、双重认证验证码全部由用户自己在浏览器里输入。
 * 2. **不碰凭据存储。** 不读 cookies，只做 `Storage.clearDataForOrigin`（登出时才用）。
 * 3. **专用 profile。** 用独立 `--user-data-dir`，与用户日常浏览器隔离；
 *    这也正是「退出登录能真正清干净」的前提。
 */

/** 专用 profile 目录：与桥约定的一致，改了会让已登录的用户重新登录一次。 */
const DEFAULT_PROFILE_DIR = path.join(
    process.env.LOCALAPPDATA || process.env.HOME || '.',
    'FoliaAMProfile',
);

/** 引导用户登录的落地页。必须落在 `music.apple.com` 下，桥才认。 */
// l=zh-CN：让 Apple 网页本身也说中文，不跟着账号里的语言设置走。
const SIGN_IN_URL = 'https://music.apple.com/cn/home?l=zh-CN';

/**
 * 登出时要清空的源。
 *
 * `music.apple.com` 存音乐侧会话；`amp-api` 存 api 域下的分区数据。
 * `appleid.apple.com` 只在用户专门要求「连 Apple ID 一起退」时才有意义 ——
 * 那会影响用户其它苹果服务，**不在这里做**。
 */
const CLEARABLE_ORIGINS = Object.freeze([
    'https://music.apple.com',
    'https://amp-api.music.apple.com',
]);

/** 拉起浏览器后等 CDP 端点就绪的上限。冷启动实测 2~4 秒。 */
const SPAWN_READY_TIMEOUT_MS = 15000;

const PROBE_TIMEOUT_MS = 1500;

/** 起来后等页面把 MusicKit 实例化好的上限；不等就会拿到「MusicKit 未就绪」。 */
const MUSICKIT_READY_TIMEOUT_MS = 25000;

/** 后台自检拉起的最小间隔：连续失败的请求不该反复开浏览器。 */
const DATA_ENSURE_COOLDOWN_MS = 60 * 1000;
/** 收掉自己拉起的进程时，等它真正退出的上限（profile 目录要等锁释放）。 */
const OWNED_EXIT_TIMEOUT_MS = 5000;

/** Windows 上常见安装位置，按「优先 Edge」排序（Windows 必装，Chrome 不一定有）。 */
const WINDOWS_BROWSER_CANDIDATES = Object.freeze([
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]);

/** macOS / Linux 的候选（本项目主要在 Windows 上跑，这里只作兜底）。 */
const POSIX_BROWSER_CANDIDATES = Object.freeze([
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
]);

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

/** 逐个探测候选可执行文件；`exists` 可注入，便于单测。 */
function resolveBrowserExecutable({ exists = fs.existsSync, override = process.env.FOLIA_APPLE_BROWSER } = {}) {
    if (override && exists(override)) return override;
    const candidates = process.platform === 'win32' ? WINDOWS_BROWSER_CANDIDATES : POSIX_BROWSER_CANDIDATES;
    for (const candidate of candidates) {
        if (exists(candidate)) return candidate;
    }
    return null;
}

/**
 * 组装启动参数。单独拎出来是为了能在单测里断言「不会带 --headless、
 * 不会带 --mute-audio、不会带自动填充账号的参数」，这类回归比行为回归更值得锁住。
 *
 * 为什么不再有「无头 + 静音」分支：Apple 的播放推进依赖「有一个真实窗口、且没被静音」。
 * 后台取数据时宁可开一个随即收进任务栏的真实窗口，也不要静音的无头实例——
 * 后者会造成「进度在走、歌词在动，但一点声音都没有」，而且点登录时根本没有窗口可显示。
 * 代价只有一个：第一次用到 Apple 功能时，任务栏会多一个已最小化的窗口。
 */
function buildLaunchArgs({ endpoint = DEFAULT_CDP_ENDPOINT, profileDir = DEFAULT_PROFILE_DIR, url = SIGN_IN_URL, background = false } = {}) {
    const port = Number(new URL(endpoint).port || 9222);
    return [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        // 一次性窗口：不复用用户日常窗口，也不弹「恢复会话」。
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
        // 这个浏览器由 Folia 指挥，播放指令来自应用而不是页面里的点击。
        // 不放开自动播放策略，Chromium 会以「没有用户手势」为由把声音静掉，
        // 表现正好是「进度条走、但没有声音」。
        '--autoplay-policy=no-user-gesture-required',
        // 播放期间窗口会留在后台（被 Folia 盖住或最小化）而音乐不能停：
        // 关掉后台节流与遮挡判定，否则计时器/rAF 被降频，进度就不走了。
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        // 这个 profile 只跑 music.apple.com：Edge 自带扩展（实测 523 MB）与组件/模型
        // （component_crx_cache + ProvenanceData，实测 371 MB）对登录和播放毫无用处，
        // 却会在首次启动时整包灌进 profile，所以一并关掉。
        '--disable-extensions',
        '--disable-component-update',
        '--disable-sync',
        '--no-service-autorun',
        // 后台实例：开着窗口但放到屏幕外。不能最小化 —— 最小化后页面变成 hidden，
        // Apple Music 会拒绝播放；放到屏幕外则仍是 visible，播放正常推进，用户也看不见。
        ...(background ? ['--window-position=-32000,-32000', '--window-size=520,400'] : []),
        '--new-window',
        url,
    ];
}

/** CDP 端点是否活着。用 HTTP 探测而不是连 WebSocket，避免留下半开连接。 */
function probeEndpoint(endpoint = DEFAULT_CDP_ENDPOINT) {
    return new Promise(resolve => {
        const request = http.get(`${endpoint}/json/version`, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.setTimeout(PROBE_TIMEOUT_MS, () => {
            request.destroy();
            resolve(false);
        });
    });
}

/** 通过 CDP 的 `Browser.setWindowBounds` 收窗口，避免依赖各平台窗口 API。 */
/**
 * 把窗口挪到屏幕外的一角。
 *
 * 不能最小化：最小化后页面变 hidden，Apple Music 会拒绝播放（时间戳不动）。
 * 挪到屏幕外则仍是 normal 窗口、页面仍是 visible，播放与声音都不受影响，
 * 用户平时也看不见它；需要登录时再挪回来。
 */
async function parkOffscreenWindow(endpoint, target, openConnection = CdpConnection.open) {
    const connection = await openConnection(target.webSocketDebuggerUrl);
    try {
        const { windowId } = await connection.send('Browser.getWindowForTarget', { targetId: target.id });
        await connection.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal', left: -32000, top: -32000, width: 520, height: 400 },
        });
        return true;
    } finally {
        connection.close();
    }
}

/** 把已有窗口提到前台，并把它切到用户要操作的登录页。 */
async function focusWindow(endpoint, target, openConnection = CdpConnection.open) {
    const connection = await openConnection(target.webSocketDebuggerUrl);
    try {
        const { windowId } = await connection.send('Browser.getWindowForTarget', { targetId: target.id });
        // 登录窗口必须先挪回屏幕内：后台实例平时停在屏幕外，直接 normal 还是看不见。
        await connection.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'normal', left: 160, top: 90, width: 960, height: 760 },
        });
        await connection.send('Page.bringToFront');
        return true;
    } finally {
        connection.close();
    }
}

/** 在已运行的浏览器里新开一个 Apple Music 标签页（Chromium 111+ 要求 PUT）。 */
function openTab(endpoint, url = SIGN_IN_URL) {
    return new Promise((resolve, reject) => {
        const request = http.request(
            `${endpoint}/json/new?${encodeURIComponent(url)}`,
            { method: 'PUT' },
            response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`open tab failed with status ${response.statusCode}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(body));
                    } catch (error) {
                        reject(new Error(`open tab returned non-JSON: ${error.message}`));
                    }
                });
            },
        );
        request.on('error', reject);
        request.setTimeout(5000, () => request.destroy(new Error('open tab timed out')));
        request.end();
    });
}

async function waitUntilReady(endpoint, timeoutMs = SPAWN_READY_TIMEOUT_MS, probe = probeEndpoint) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probe(endpoint)) return true;
        await sleep(250);
    }
    return false;
}

/** 页面里 MusicKit 实例可用才算「能取会话」，光有 window.MusicKit 不够。 */
const MUSICKIT_READY_EXPRESSION = '(() => { try { return Boolean(window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance()); } catch (e) { return false; } })()';

/**
 * 等 Apple Music 页面把 MusicKit 实例化好。刚拉起的浏览器页面还在加载，
 * 这时候发请求只会拿到「MusicKit 未就绪」。
 */
async function waitForMusicKit(endpoint, { timeoutMs = MUSICKIT_READY_TIMEOUT_MS, list = listTargets, openConnection = CdpConnection.open } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const targets = await list(endpoint).catch(() => []);
        const page = pickAppleMusicTargetWithDetails(targets);
        if (page) {
            try {
                const connection = await openConnection(page.webSocketDebuggerUrl);
                try {
                    await connection.send('Runtime.enable');
                    const result = await connection.send('Runtime.evaluate', {
                        expression: MUSICKIT_READY_EXPRESSION,
                        returnByValue: true,
                    });
                    if (result?.result?.value === true) return true;
                } finally {
                    connection.close();
                }
            } catch { /* 页面还在导航，下一轮再看 */ }
        }
        await sleep(500);
    }
    return false;
}

/**
 * 浏览器模块的门面。所有方法都不触碰账号数据，失败一律返回
 * `{ ok: false, reason }` 而不是抛错 —— 渲染层要据此决定「降级还是引导」。
 */
function createAppleMusicBrowser({
    endpoint = DEFAULT_CDP_ENDPOINT,
    profileDir = DEFAULT_PROFILE_DIR,
    resolveExecutable = resolveBrowserExecutable,
    spawnProcess = spawn,
    probe = probeEndpoint,
    list = listTargets,
    openConnection = CdpConnection.open,
} = {}) {
    /** 我们拉起的子进程；只要它还在，就说明「这个浏览器是本次会话的」。 */
    let ownedProcess = null;
    let ownedExecutable = null;
    /** 我们拉起的是哪一种：'background' = 随即收进任务栏的后台窗口；'headed' = 用户正在操作的窗口。 */
    let ownedMode = null;
    /** 后台自检拉起的最小间隔，避免请求连续失败时反复开进程。 */
    let lastForDataAt = 0;

    const findPage = async () => {
        const targets = await list(endpoint);
        return pickAppleMusicTargetWithDetails(targets);
    };

    /** 收掉我们自己拉起的进程（切换模式前必须先让它退，否则 profile 目录被占）。 */
    const stopOwned = async () => {
        const child = ownedProcess;
        ownedProcess = null;
        ownedMode = null;
        if (!child) return;
        try { child.kill(); } catch { /* 已经退了 */ }
        const deadline = Date.now() + OWNED_EXIT_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (!await probe(endpoint)) return;
            await sleep(100);
        }
    };

    return {
        /** 当前是否有可用的 CDP 端点（不论是不是我们拉起的）。 */
        async probe() {
            return probe(endpoint);
        },

        /**
         * 确保「用户能看到并操作一个已登录态的 Apple Music 页面」。
         *
         * 三种情况：
         * 1. 端点活着且有 Apple 页 → 提到前台（并恢复最小化状态）；
         * 2. 端点活着但没有 Apple 页 → 新开一个标签页再提到前台；
         * 3. 端点死了 → 拉起专用浏览器。
         *
         * `background: true` 表示「只为取数据而拉起」：仍然开真实窗口（否则会静音、播放不推进），
         * 但把窗口放到屏幕外，用户看不见、也不会抢焦点。
         */
        async ensure({ visible = true, background = false } = {}) {
            if (await probe(endpoint)) {
                // 要用户操作的窗口，但我们手里只有后台实例：先收掉它再开可见的，
                // 否则同一个 profile 目录被占，新的窗口起不来。
                if (visible && ownedMode === 'background') {
                    await stopOwned();
                } else {
                    const existing = await findPage().catch(() => null);
                    if (existing) {
                        // 后台取数据时绝不 focus —— 抢焦点正是要避免的事。
                        if (visible) await focusWindow(endpoint, existing, openConnection).catch(() => false);
                        return { ok: true, reused: true, spawned: false, background: ownedMode === 'background' };
                    }
                    const created = await openTab(endpoint).catch(() => null);
                    if (!created) return { ok: false, reason: 'open-tab-failed' };
                    // 刚建的标签页还没加载完，拿不到 windowId 也要保证用户看得见。
                    if (visible) await sleep(300);
                    return { ok: true, reused: true, spawned: false, background: ownedMode === 'background' };
                }
            }

            const executable = resolveExecutable();
            if (!executable) return { ok: false, reason: 'no-browser' };

            const child = spawnProcess(executable, buildLaunchArgs({ endpoint, profileDir, background }), {
                detached: true,
                stdio: 'ignore',
            });
            child.unref?.();
            ownedProcess = child;
            ownedExecutable = executable;
            ownedMode = background ? 'background' : 'headed';

            if (!await waitUntilReady(endpoint, SPAWN_READY_TIMEOUT_MS, probe)) {
                return { ok: false, reason: 'browser-not-ready', executable };
            }
            // 后台实例是给「取数据」用的：必须等页面能取会话，否则重试还是失败。
            // 可见窗口不等：用户还要自己登录，慢慢来。
            const readyForData = background
                ? await waitForMusicKit(endpoint, { list, openConnection })
                : true;
            // 后台实例：挪到屏幕外。窗口还在、页面仍 visible，所以播放照常推进、声音照常出。
            if (background) {
                const page = await findPage().catch(() => null);
                if (page) await parkOffscreenWindow(endpoint, page, openConnection).catch(() => false);
            }
            return { ok: true, reused: false, spawned: true, executable, background, readyForData };
        },

        /**
         * 取数据用的自检：浏览器没开（或已经被关掉）时，静默拉一个后台实例。
         *
         * 这是「关掉浏览器就听不了歌」的兜底：不需要用户操作，也不抢焦点 ——
         * 后台实例拉起来后立刻收进任务栏；要登录时再由
         * `ensure({ visible: true })` 恢复成正常窗口。带最小间隔，避免反复开进程。
         */
        async ensureForData() {
            if (await probe(endpoint)) {
                const existing = await findPage().catch(() => null);
                if (existing) {
                    const readyForData = await waitForMusicKit(endpoint, { list, openConnection });
                    // 复用的实例也可能是之前登录时留下的可见窗口，统一挪回屏幕外。
                    if (readyForData) await parkOffscreenWindow(endpoint, existing, openConnection).catch(() => false);
                    return { ok: readyForData, reused: true, spawned: false, background: ownedMode === 'background', readyForData };
                }
            }
            const now = Date.now();
            if (now - lastForDataAt < DATA_ENSURE_COOLDOWN_MS) {
                return { ok: false, reason: 'cooldown' };
            }
            lastForDataAt = now;
            return this.ensure({ visible: false, background: true });
        },

        /** 用户登录完成后把窗口挪回屏幕外。挪不走不算失败，只是体验降级。 */
        async hide() {
            const target = await findPage().catch(() => null);
            if (!target) return { ok: false, reason: 'no-page' };
            try {
                await parkOffscreenWindow(endpoint, target, openConnection);
                return { ok: true };
            } catch (error) {
                return { ok: false, reason: 'park-failed', detail: error.message };
            }
        },

        /**
         * 登出（L3）：把 Apple Music 站点的存储清空，再让页面自己回到未登录态。
         *
         * 只清 `music.apple.com` 系源的存储 —— 不碰 Apple ID 本身，
         * 用户其它苹果服务不受影响。清完必须 reload，否则页面内存里的
         * MusicKit 实例还举着旧令牌。
         */
        async clearSession() {
            const target = await findPage().catch(() => null);
            if (!target) return { ok: true, cleared: false, reason: 'no-page' };

            const connection = await openConnection(target.webSocketDebuggerUrl);
            try {
                await connection.send('Network.enable').catch(() => {});
                await connection.send('Storage.enable').catch(() => {});
                for (const origin of CLEARABLE_ORIGINS) {
                    await connection.send('Storage.clearDataForOrigin', {
                        origin,
                        storageTypes: 'all',
                    });
                }
                await connection.send('Page.reload', { ignoreCache: true });
                await sleep(1200);
                return { ok: true, cleared: true };
            } catch (error) {
                return { ok: false, reason: 'clear-failed', detail: error.message };
            } finally {
                connection.close();
            }
        },

        /** 记录本次是否由我们拉起，用于「重启后不用重新拉」的判断与调试。 */
        status() {
            return {
                endpoint,
                profileDir,
                probe: null,
                owned: Boolean(ownedProcess),
                /** 'background' = 我们拉起、随即收进任务栏的后台窗口；'headed' = 用户正在操作的窗口；null = 不是我们拉起的。 */
                mode: ownedMode,
                executable: ownedExecutable,
            };
        },

        /**
         * 退出时收掉自己拉起的浏览器。
         *
         * 不变量：这里只杀「本次会话由我们拉起的那个进程」，绝不去动用户自己开的浏览器；
         * 杀不掉（已被手动关掉）也算正常。留着它没有好处：下次启动会撞 profile 锁，
         * 任务栏还多一个没有主的窗口。
         */
        dispose() {
            const child = ownedProcess;
            ownedProcess = null;
            ownedExecutable = null;
            ownedMode = null;
            if (!child) return;
            try { child.kill(); } catch { /* 已经退了 */ }
        },
    };
}

module.exports = {
    DEFAULT_PROFILE_DIR,
    SIGN_IN_URL,
    CLEARABLE_ORIGINS,
    buildLaunchArgs,
    createAppleMusicBrowser,
    probeEndpoint,
    resolveBrowserExecutable,
    APPLE_MUSIC_PAGE_PREFIX,
};
