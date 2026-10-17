import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/appleMusicBridge.test.ts — bridge policy, path construction and status mapping.
// The live CDP transport is injected, so these tests never touch a browser.

const require = createRequire(import.meta.url);
const {
    APPLE_OPERATION_PATHS,
    createAppleMusicBridge,
    clampLimit,
    toEnvelope,
    pickAppleMusicTarget,
} = require('../../../electron/appleMusicBridge.cjs');

const HELPER_READY = { ok: true, auth: true, sf: 'cn', tokLen: 120, usrLen: 246 };

/** A stand-in for the CDP connection. Helper injection is told apart from a data fetch by `awaitPromise`. */
const createFakeConnection = (script: { helper?: () => unknown; get?: (path: string) => unknown } = {}) => {
    const connection = {
        closed: false,
        paths: [] as string[],
        helperInstalls: 0,
        lifecycle: [] as string[],
        close() { connection.closed = true; },
        async send(method: string, params?: { state?: string }) {
            if (method === 'Page.setWebLifecycleState') connection.lifecycle.push(params?.state ?? '');
            return {};
        },
        async evaluate(expression: string, options?: { awaitPromise?: boolean }) {
            if (!options?.awaitPromise) {
                connection.helperInstalls += 1;
                return script.helper ? script.helper() : HELPER_READY;
            }
            const marker = 'window.__AM.get(';
            const path = JSON.parse(expression.slice(expression.indexOf(marker) + marker.length, -1));
            connection.paths.push(path);
            return script.get ? script.get(path) : { ok: true, status: 200, json: { data: [{ id: 'p.1' }] } };
        },
    };
    return connection;
};

const bridgeWith = (connection: unknown, options: Record<string, unknown> = {}) =>
    createAppleMusicBridge({ connect: async () => connection, warn: () => {}, ...options });

describe('Apple Music bridge', () => {
    it('rejects unregistered operations before opening the browser', async () => {
        const connect = vi.fn();
        const bridge = createAppleMusicBridge({ connect });
        // `constructor` / `valueOf` 这类继承键曾经能命中 Object 原型并绕过白名单。
        const operations = ['fetch', 'constructor', 'toString', 'valueOf', 'hasOwnProperty',
            '__proto__', 'library_playlist_create', 'play'];
        for (const operation of operations) {
            expect(await bridge.request(operation, {})).toMatchObject({ ok: false, error: { code: 'unsupported' } });
        }
        expect(connect).not.toHaveBeenCalled();
    });

    it('keeps every registered operation on the read-only amp-api surface', () => {
        // 只读是硬边界：任何白名单项都必须落在 /v1/ 只读端点上，且都不需要写入方法。
        type BuildPath = (params: Record<string, unknown>) => string | null;
        const entries = Object.entries(APPLE_OPERATION_PATHS) as Array<[string, BuildPath]>;
        for (const [operation, build] of entries) {
            if (operation === 'session' || operation === 'ping') {
                expect(build({})).toBeNull();
                continue;
            }
            const path = build({ id: 'p.1', term: 'utada' });
            expect(path).toMatch(/^\/v1\//);
            expect(path).not.toMatch(/\/(me|library)\/[a-z]*\/?(create|add|delete)/);
        }
    });

    it('builds library and catalog paths with clamped paging', async () => {
        const connection = createFakeConnection();
        const bridge = bridgeWith(connection);
        await bridge.request('library_playlists', { limit: 999, offset: -3 });
        await bridge.request('library_playlist_tracks', { id: 'p.DV7rLXos4P46GgY' });
        await bridge.request('catalog_search', { term: '宇多田ヒカル', types: ['songs'], limit: 5 });
        await bridge.request('song_lyrics', { id: '1440833098', storefront: 'jp' });
        expect(connection.paths).toEqual([
            '/v1/me/library/playlists?limit=100&offset=0',
            '/v1/me/library/playlists/p.DV7rLXos4P46GgY/tracks?limit=100&offset=0',
            `/v1/catalog/cn/search?term=${encodeURIComponent('宇多田ヒカル')}&types=songs&limit=5&offset=0`,
            '/v1/catalog/jp/songs/1440833098/lyrics',
        ]);
    });

    it('refuses to build a path from a missing or escaping media id', async () => {
        const connection = createFakeConnection();
        const bridge = bridgeWith(connection);
        for (const params of [{}, { id: '' }, { id: '   ' }]) {
            expect(await bridge.request('library_playlist_detail', params))
                .toMatchObject({ ok: false, error: { code: 'unsupported' } });
        }
        expect(await bridge.request('catalog_search', { term: '  ' }))
            .toMatchObject({ ok: false, error: { code: 'unsupported' } });
        expect(connection.paths).toEqual([]);
        // 斜杠被编码：媒体 id 不能靠路径穿越跳出 /v1/ 前缀。
        expect(APPLE_OPERATION_PATHS.library_playlist_detail({ id: '../../me/library/songs' }))
            .toBe('/v1/me/library/playlists/..%2F..%2Fme%2Flibrary%2Fsongs');
    });

    it('maps upstream status codes onto the project error vocabulary', () => {
        expect(toEnvelope('x', { ok: true, status: 200, json: { data: [] } })).toEqual({ ok: true, data: { data: [] } });
        expect(toEnvelope('x', { ok: true, status: 200, json: null, text: '<html>' }))
            .toMatchObject({ ok: false, error: { code: 'invalid-response', text: '<html>' } });
        const cases: Array<[number, string]> = [[401, 'auth-required'], [403, 'auth-required'], [404, 'unsupported'],
            [429, 'rate-limited'], [500, 'service-unavailable'], [503, 'service-unavailable'], [418, 'invalid-response']];
        for (const [status, code] of cases) {
            expect(toEnvelope('x', { ok: false, status, json: null }))
                .toMatchObject({ ok: false, error: { code, httpStatus: status } });
        }
        expect(toEnvelope('x', undefined)).toMatchObject({ ok: false, error: { code: 'invalid-response' } });
    });

    it('reports an unreachable browser distinctly from an Apple failure', async () => {
        const targetError = Object.assign(new Error('没有目标页'), { code: 'no-apple-target' });
        const bridge = createAppleMusicBridge({ connect: async () => { throw targetError; } });
        expect(await bridge.request('library_playlists', {}))
            .toMatchObject({ ok: false, error: { code: 'unavailable', reason: 'no-apple-target' } });
    });

    it('injects the page helper once and reuses it across requests', async () => {
        const connection = createFakeConnection();
        const bridge = bridgeWith(connection);
        await bridge.request('library_playlists', {});
        await bridge.request('library_songs', {});
        expect(connection.helperInstalls).toBe(1);
        await bridge.request('session', {});
        expect(connection.helperInstalls).toBe(1);
        expect(await bridge.request('session', {})).toEqual({ ok: true, data: HELPER_READY });
    });

    it('未登录的页面返回 auth:false 而不是报错（后台实例刚起来时就是这种状态）', async () => {
        const helper = { ok: true, auth: false, sf: 'cn', tokLen: 268, usrLen: 0 };
        const bridge = bridgeWith(createFakeConnection({ helper: () => helper }));
        await expect(bridge.request('session', {})).resolves.toEqual({ ok: true, data: helper });
    });

    it('助手脚本对缺失的 musicUserToken 兜底，不会抛 Uncaught', () => {
        // 未登录时 mk.musicUserToken 是 undefined，直接取 .length 会让整个注入抛异常，
        // 调用方只能拿到一个没有信息的 'Uncaught'。
        const source = readFileSync(new URL('../../../electron/appleMusicBridge.cjs', import.meta.url), 'utf8');
        expect(source).toContain("mk.developerToken || ''");
        expect(source).toContain("mk.musicUserToken || ''");
    });

    it.each([
        ['missing MusicKit', { ok: false, error: 'MusicKit 未就绪' }],
        ['no MusicKit instance', { ok: false }],
        ['non-object helper state', null],
    ])('surfaces an unusable page (%s) as auth-required', async (_label, helper) => {
        const bridge = bridgeWith(createFakeConnection({ helper: () => helper }));
        expect(await bridge.request('library_playlists', {}))
            .toMatchObject({ ok: false, error: { code: 'auth-required' } });
    });

    it('re-injects the helper when a navigation cleared the page global', async () => {
        let attempts = 0;
        const connection = createFakeConnection({
            get: () => (++attempts === 1 ? undefined : { ok: true, status: 200, json: { data: [{ id: 'p.1' }] } }),
        });
        const bridge = bridgeWith(connection);
        expect(await bridge.request('library_playlists', {})).toMatchObject({ ok: true });
        expect(connection.helperInstalls).toBe(2);
        expect(attempts).toBe(2);
    });

    it('keeps the background tab unfrozen before every fetch', async () => {
        // 冻结的后台标签页里 fetch 的 promise 永远不 settle；解冻不抢焦点，所以每次取数前都刷一次。
        const connection = createFakeConnection();
        const bridge = bridgeWith(connection);
        await bridge.request('library_playlists', {});
        await bridge.request('library_songs', {});
        expect(connection.lifecycle).toEqual(['active', 'active']);
    });

    it('still fetches when the runtime has no lifecycle command', async () => {
        const connection = createFakeConnection();
        connection.send = async () => { throw new Error('method not found'); };
        expect(await bridgeWith(connection).request('library_playlists', {})).toMatchObject({ ok: true });
    });

    it('drops a broken connection so the next request reconnects', async () => {
        const first = createFakeConnection({ get: () => { throw new Error('CDP connection closed'); } });
        const second = createFakeConnection();
        const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
        const bridge = createAppleMusicBridge({ connect, warn: () => {} });
        expect(await bridge.request('library_playlists', {}))
            .toMatchObject({ ok: false, error: { code: 'network', detail: 'CDP connection closed' } });
        expect(await bridge.request('library_playlists', {})).toMatchObject({ ok: true });
        expect(connect).toHaveBeenCalledTimes(2);
    });

    it('shares one connection between concurrent requests', async () => {
        const connection = createFakeConnection();
        const connect = vi.fn(async () => connection);
        const bridge = createAppleMusicBridge({ connect });
        await Promise.all([bridge.request('library_playlists', {}), bridge.request('library_songs', {})]);
        expect(connect).toHaveBeenCalledTimes(1);
        bridge.dispose();
        expect(connection.closed).toBe(true);
    });

    it('picks the Apple Music page and names what it saw when absent', () => {
        const apple = { type: 'page', url: 'https://music.apple.com/cn/new', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/x' };
        expect(pickAppleMusicTarget([{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://a' }, apple])).toBe(apple);
        const error = pickAppleMusicTarget([{ type: 'page', url: 'https://example.test/', webSocketDebuggerUrl: 'ws://a' }]);
        expect(error).toMatchObject({ code: 'no-apple-target' });
        expect(error.message).toContain('example.test');
    });

    it('clamps the page limit to the upstream maximum of 100', () => {
        expect(clampLimit(25)).toBe(25);
        expect(clampLimit(0)).toBe(100);
        expect(clampLimit(1e9)).toBe(100);
        expect(clampLimit('abc', 5)).toBe(5);
    });
});
