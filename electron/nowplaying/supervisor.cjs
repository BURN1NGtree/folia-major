// electron/nowplaying/supervisor.cjs
// 内置 now-playing 服务的监管者：把 electron/nowplaying/bridge.mjs 以 utilityProcess 拉起，
// 崩溃按退避重启，Folia 退出时结束。首次由「用户真的在用 Apple 音源」触发（见 main.cjs 的
// apple-music-request / apple-music-browser-ensure），不是随 app 启动无条件起。
//
// 三条边界：
//   1. 只接管自己拉起的进程；端口已被外部服务占用（用户手动跑着 bridge.mjs）时不抢、不重启。
//   2. 不在模块加载时 require('electron')——单元测试要在纯 Node 下跑，注入 fork 即可。
//   3. 子进程的 stdout/stderr 手工转发：Windows 下 utilityProcess 的 'inherit' 会静默丢输出，
//      这与 electron/analysis/host.cjs 的实测结论一致。
const path = require('node:path');
const net = require('node:net');

/** 服务端口。与 src/hooks/useNowPlayingSource.ts 里写死的 9863 一致，不可随意改。 */
const DEFAULT_PORT = 9863;

/** 退出后重试的退避序列，用完后固定停在最后一档。 */
const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 30000];

/** 连续运行超过这个时长，把退避计数清零（避免偶发崩溃一路把间隔推到 30 秒）。 */
const HEALTHY_RUN_MS = 60_000;

/**
 * 探测端口是否已有服务在监听。连得上就算忙——
 * 只用来判断「是不是别人占着」，不关心那边回的什么协议。
 */
function isPortBusy(port, host = '127.0.0.1', timeoutMs = 400) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const done = (busy) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(busy);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
        socket.connect(port, host);
    });
}

/**
 * 建立监管者。所有对外效果都通过参数注入，便于单测：
 *   fork(scriptPath, env) → 类 utilityProcess 的子进程（需有 kill()、stdout/stderr、on('exit')）
 *   probePort(port)       → Promise<boolean>，默认连 TCP 判断
 */
function createNowPlayingSupervisor(options = {}) {
    const {
        scriptPath = path.join(__dirname, 'bridge.mjs'),
        port = DEFAULT_PORT,
        env = {},
        log = (...args) => console.log(...args),
        fork = null,
        probePort = (targetPort) => isPortBusy(targetPort),
        restartDelays = RESTART_DELAYS_MS,
        healthyRunMs = HEALTHY_RUN_MS,
    } = options;

    /** idle | running | restarting | external | stopped */
    let state = 'idle';
    let child = null;
    let restartIndex = 0;
    let restartTimer = null;
    let startedAtMs = 0;
    let intentionalStop = false;
    // 并发保护：ensureStarted 里要 await 探端口，期间重复调用只能触发一次 fork。
    let pendingStart = null;

    const status = () => ({
        state,
        pid: child?.pid ?? null,
        restartIndex,
        port,
    });

    /** 真正 fork。utilityProcess 在 app ready 之前不可用，所以延迟到第一次 spawn 时再取。 */
    const spawnOnce = () => {
        const forkChild = fork || ((modulePath, childEnv) => {
            // 只有运行期才 require：纯 Node 单测走注入，不碰 electron。
            const { utilityProcess } = require('electron');
            return utilityProcess.fork(modulePath, [], {
                stdio: 'pipe',
                serviceName: 'folia-nowplaying',
                env: childEnv,
            });
        });
        const started = forkChild(scriptPath, { ...process.env, BRIDGE_PORT: String(port), ...env });
        const forward = (stream, name) => stream?.on('data', (chunk) => {
            log(`[nowplaying:${name}] ${String(chunk).trimEnd()}`);
        });
        forward(started.stdout, 'out');
        forward(started.stderr, 'err');
        started.on('exit', (code) => handleExit(code));
        child = started;
        startedAtMs = Date.now();
        state = 'running';
        // pid 在 fork 返回那一刻还没分配，等 'spawn' 再打日志。
        if (typeof started.once === 'function') {
            started.once('spawn', () => log(`[nowplaying] 已启动（pid ${started.pid ?? '?'}，端口 ${port}）`));
        } else {
            log(`[nowplaying] 已启动（端口 ${port}）`);
        }
    };

    const scheduleRestart = () => {
        const delay = restartDelays[Math.min(restartIndex, restartDelays.length - 1)];
        restartIndex += 1;
        state = 'restarting';
        log(`[nowplaying] ${delay} ms 后重启（第 ${restartIndex} 次）`);
        restartTimer = setTimeout(() => {
            restartTimer = null;
            if (intentionalStop) return;
            spawnOnce();
        }, delay);
        if (restartTimer.unref) restartTimer.unref();
    };

    const handleExit = (code) => {
        child = null;
        if (intentionalStop) {
            state = 'stopped';
            return;
        }
        if (Date.now() - startedAtMs >= healthyRunMs) restartIndex = 0;
        // 端口被别人占了（用户刚手动起了外部服务），就别再抢：
        // 探一次再决定，避免与外部服务反复争夺同一个端口。
        void probePort(port).then((busy) => {
            if (intentionalStop) return;
            if (busy) {
                state = 'external';
                log(`[nowplaying] 端口 ${port} 已被其他服务占用，停止内置实例`);
                return;
            }
            scheduleRestart();
        });
        log(`[nowplaying] 子进程退出（code ${code ?? '?'}）`);
    };

    /**
     * 首次确保服务在跑。已运行、已判定外部、已停止都直接返回；
     * 端口被占则标记 external，之后不再尝试（外部服务自己会提供 9863）。
     */
    async function ensureStarted(reason = '') {
        if (state === 'running' || state === 'external' || state === 'stopped') return status();
        if (pendingStart) return pendingStart;
        pendingStart = (async () => {
            const busy = await probePort(port).catch(() => false);
            if (busy) {
                state = 'external';
                log(`[nowplaying] 端口 ${port} 已有服务在跑（不接管），原因：${reason || '未知'}`);
                return status();
            }
            intentionalStop = false;
            spawnOnce();
            return status();
        })();
        try {
            return await pendingStart;
        } finally {
            pendingStart = null;
        }
    }

    /** 主动停止：取消待执行的重启，杀掉自己拉起的子进程。 */
    function stop() {
        intentionalStop = true;
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
        const running = child;
        child = null;
        if (running) {
            try {
                running.kill();
            } catch (error) {
                log(`[nowplaying] 停止失败：${error.message}`);
            }
            log('[nowplaying] 已停止');
        }
        state = 'stopped';
    }

    return { ensureStarted, stop, status };
}

module.exports = { createNowPlayingSupervisor, isPortBusy, DEFAULT_PORT, RESTART_DELAYS_MS };
