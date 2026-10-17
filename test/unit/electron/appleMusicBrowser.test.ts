import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicBrowser.test.ts — 专用浏览器的启动参数、可执行文件解析与会话清理。
// 所有浏览器交互都注入替身，测试不启动任何进程、不连 CDP。

const require = createRequire(import.meta.url);
const {
    buildLaunchArgs,
    createAppleMusicBrowser,
    resolveBrowserExecutable,
    CLEARABLE_ORIGINS,
} = require('../../../electron/appleMusicBrowser.cjs');

const APPLE_PAGE = {
    id: 'page-1',
    type: 'page',
    url: 'https://music.apple.com/cn/home',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1',
};

/** 假的 CDP 连接：记下发过什么，按需回答 Browser.getWindowForTarget。 */
const createFakeConnection = () => {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    return {
        sent,
        closed: false,
        close() { this.closed = true; },
        async send(method: string, params?: Record<string, unknown>) {
            sent.push({ method, params });
            if (method === 'Browser.getWindowForTarget') return { windowId: 7 };
            // 就绪探测：默认认为页面已经可用，免得后台模式一直等到超时。
            if (method === 'Runtime.evaluate') return { result: { value: true } };
            return {};
        },
    };
};

describe('buildLaunchArgs', () => {
    it('带上调试端口、专用 profile 与登录页，且不带头无头/静音/自动填充类参数', () => {
        const args = buildLaunchArgs({ endpoint: 'http://127.0.0.1:9333', profileDir: 'C:\\profile' });
        expect(args).toContain('--remote-debugging-port=9333');
        expect(args).toContain('--user-data-dir=C:\\profile');
        // l=zh-CN：让 Apple 网页自己说中文，不跟账号语言设置走。
        expect(args).toContain('https://music.apple.com/cn/home?l=zh-CN');
        // 用户在窗口里亲手登录，必须可见；自动填充会把「不代填」这条边界悄悄破掉。
        expect(args.some((arg: string) => arg.startsWith('--headless'))).toBe(false);
        expect(args.some((arg: string) => /autofill|password-store/i.test(arg))).toBe(false);
        // 静音 + 无头会让「进度在走但没有声音」：这条路必须彻底消失。
        expect(args).not.toContain('--mute-audio');
        expect(args).toContain('--new-window');
        // 这个 profile 只服务 music.apple.com：Edge 自带扩展与组件更新会把几百 MB
        // 灌进 profile，必须在可见窗口也关掉（以前只有 headless 分支关）。
        expect(args).toContain('--disable-extensions');
        expect(args).toContain('--disable-component-update');
    });
});

describe('resolveBrowserExecutable', () => {
    it('优先用环境变量指定的浏览器', () => {
        const executable = resolveBrowserExecutable({
            override: 'D:\\Edge\\msedge.exe',
            exists: (candidate: string) => candidate === 'D:\\Edge\\msedge.exe',
        });
        expect(executable).toBe('D:\\Edge\\msedge.exe');
    });

    it('环境变量指向不存在的路径时退回候选列表', () => {
        const executable = resolveBrowserExecutable({
            override: 'D:\\missing.exe',
            exists: (candidate: string) => candidate.includes('Microsoft\\Edge\\Application\\msedge.exe'),
        });
        expect(executable).toContain('msedge.exe');
    });

    it('一个都没有时返回 null，交给界面提示装浏览器', () => {
        expect(resolveBrowserExecutable({ exists: () => false })).toBeNull();
    });
});

describe('createAppleMusicBrowser.ensure', () => {
    it('端点活着且已有 Apple 页面时只聚焦，不再拉起进程', async () => {
        const spawnProcess = vi.fn();
        const connection = createFakeConnection();
        const browser = createAppleMusicBrowser({
            probe: async () => true,
            list: async () => [APPLE_PAGE],
            spawnProcess,
            openConnection: async () => connection,
        });

        const result = await browser.ensure({ visible: true });

        expect(result).toMatchObject({ ok: true, reused: true, spawned: false });
        expect(spawnProcess).not.toHaveBeenCalled();
        // 恢复最小化 + 提到前台，两步都要发。
        expect(connection.sent.map(item => item.method)).toEqual(
            expect.arrayContaining(['Browser.setWindowBounds', 'Page.bringToFront']),
        );
    });

    it('后台实例：开真实窗口（否则会静音、播放不推进），放到屏幕外且不抢焦点', async () => {
        const connection = createFakeConnection();
        const spawned: string[][] = [];
        let up = false;
        const browser = createAppleMusicBrowser({
            probe: async () => up,
            list: async () => (up ? [APPLE_PAGE] : []),
            resolveExecutable: () => 'D:\Edge\msedge.exe',
            spawnProcess: (_command: string, args: string[]) => {
                spawned.push(args);
                up = true;
                return { kill: () => { up = false; }, unref: () => {} };
            },
            openConnection: async () => connection,
        });

        const result = await browser.ensure({ visible: false, background: true });

        expect(result).toMatchObject({ ok: true, spawned: true, background: true });
        expect(spawned).toHaveLength(1);
        // 不再是静音无头窗口：有窗口才推进播放，有声音才叫播放。
        expect(spawned[0]).not.toContain('--headless=new');
        expect(spawned[0]).not.toContain('--mute-audio');
        // 播放指令来自 Folia，不是页面点击，必须放开自动播放策略。
        expect(spawned[0]).toContain('--autoplay-policy=no-user-gesture-required');
        // 最小化会让页面变 hidden 而拒绝播放；放到屏幕外才既看不见又不影响播放。
        expect(spawned[0]).toContain('--window-position=-32000,-32000');
        expect(spawned[0]).toContain('--new-window');
        // 绝不 bringToFront —— 抢焦点正是要避免的事。
        expect(connection.sent.some(item => item.method === 'Page.bringToFront')).toBe(false);
    });

    it('要登录时把后台实例换成可见窗口', async () => {
        const connection = createFakeConnection();
        const spawned: string[][] = [];
        let up = false;
        const kill = vi.fn(() => { up = false; });
        const browser = createAppleMusicBrowser({
            probe: async () => up,
            list: async () => (up ? [APPLE_PAGE] : []),
            resolveExecutable: () => 'D:\Edge\msedge.exe',
            spawnProcess: (_command: string, args: string[]) => {
                spawned.push(args);
                up = true;
                return { kill, unref: () => {} };
            },
            openConnection: async () => connection,
        });

        await browser.ensure({ visible: false, background: true });
        const result = await browser.ensure({ visible: true });

        expect(result).toMatchObject({ ok: true, spawned: true, background: false });
        expect(kill).toHaveBeenCalledTimes(1);
        expect(spawned).toHaveLength(2);
        expect(spawned[1]).toContain('--new-window');
        expect(spawned[1]).not.toContain('--headless=new');
        expect(spawned[1]).not.toContain('--mute-audio');
    });

    it('退出时销毁自己拉起的实例，但没有实例时不做任何事', async () => {
        const kill = vi.fn();
        let up = false;
        const browser = createAppleMusicBrowser({
            probe: async () => up,
            list: async () => (up ? [APPLE_PAGE] : []),
            resolveExecutable: () => 'D:\Edge\msedge.exe',
            spawnProcess: () => {
                up = true;
                return { kill, unref: () => {} };
            },
            openConnection: async () => createFakeConnection(),
        });

        browser.dispose();
        expect(kill).not.toHaveBeenCalled();

        await browser.ensure({ visible: true });
        browser.dispose();
        expect(kill).toHaveBeenCalledTimes(1);
        // 再调一次也不该重复 kill。
        browser.dispose();
        expect(kill).toHaveBeenCalledTimes(1);
    });

    it('ensureForData 有冷却：连续失败不会反复开进程', async () => {
        const spawned: string[][] = [];
        let up = false;
        const browser = createAppleMusicBrowser({
            probe: async () => up,
            list: async () => (up ? [APPLE_PAGE] : []),
            resolveExecutable: () => 'D:\Edge\msedge.exe',
            spawnProcess: (_command: string, args: string[]) => {
                spawned.push(args);
                up = true;
                return { kill: () => {}, unref: () => {} };
            },
            openConnection: async () => createFakeConnection(),
        });

        await expect(browser.ensureForData()).resolves.toMatchObject({ ok: true, spawned: true });
        // 浏览器被关掉，但冷却窗口内不该再开一个进程。
        up = false;
        await expect(browser.ensureForData()).resolves.toMatchObject({ ok: false, reason: 'cooldown' });
        expect(spawned).toHaveLength(1);
    });

    it('没有可执行文件时报 no-browser，而不是抛错', async () => {
        const browser = createAppleMusicBrowser({
            probe: async () => false,
            resolveExecutable: () => null,
        });
        await expect(browser.ensure()).resolves.toMatchObject({ ok: false, reason: 'no-browser' });
    });
});

describe('createAppleMusicBrowser.clearSession', () => {
    it('清掉 Apple 系源的存储并 reload，不动 Apple ID', async () => {
        const connection = createFakeConnection();
        const browser = createAppleMusicBrowser({
            probe: async () => true,
            list: async () => [APPLE_PAGE],
            openConnection: async () => connection,
        });

        const result = await browser.clearSession();

        expect(result).toMatchObject({ ok: true, cleared: true });
        const clearedOrigins = connection.sent
            .filter(item => item.method === 'Storage.clearDataForOrigin')
            .map(item => (item.params as { origin: string }).origin);
        expect(clearedOrigins).toEqual([...CLEARABLE_ORIGINS]);
        expect(clearedOrigins).not.toContain('https://appleid.apple.com');
        expect(connection.sent.some(item => item.method === 'Page.reload')).toBe(true);
        expect(connection.closed).toBe(true);
    });

    it('浏览器没开时算「没有会话可清」，不算失败', async () => {
        const browser = createAppleMusicBrowser({ probe: async () => false, list: async () => [] });
        await expect(browser.clearSession()).resolves.toMatchObject({ ok: true, cleared: false });
    });
});
