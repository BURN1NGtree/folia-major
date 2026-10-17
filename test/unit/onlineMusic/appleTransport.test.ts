import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APPLE_OPERATIONS, requestApple } from '@/services/onlineMusic/appleTransport';
import { OnlineProviderError } from '@/types/onlineMusic';

// test/unit/onlineMusic/appleTransport.test.ts

const require = createRequire(import.meta.url);
const { APPLE_OPERATIONS: BRIDGE_OPERATIONS } = require('../../../electron/appleMusicBridge.cjs');

afterEach(() => vi.unstubAllGlobals());

// 取出 requestApple 的拒绝值；意外 resolve 时让用例失败。
const rejectionOf = (promise: Promise<unknown>) => promise.then(
    () => { throw new Error('expected requestApple to reject'); },
    (caught: unknown) => caught as OnlineProviderError,
);

describe('Apple transport and bridge operation drift', () => {
    it('keeps the renderer operation list identical to the main-process allow-list', () => {
        // 两半必须逐字一致：渲染层多一个 → 桥回 unsupported；桥多一个 → 渲染层用不上。
        // 这条断言就是防「改一边忘另一边」。
        expect([...APPLE_OPERATIONS].sort()).toEqual([...BRIDGE_OPERATIONS].sort());
    });

    it('keeps every operation name free of write verbs', () => {
        // 只读是硬边界。按 `_` 切段比对，而不是整串正则 —— 否则 `playlists` 会被 `play` 误伤。
        const writeVerbs = new Set(['create', 'update', 'delete', 'add', 'remove',
            'set', 'replace', 'upload', 'play', 'pause', 'skip']);
        for (const operation of APPLE_OPERATIONS) {
            for (const segment of operation.split('_')) {
                expect(writeVerbs.has(segment), `${operation} 含有写入动词 "${segment}"`).toBe(false);
            }
        }
    });
});

describe('Apple transport failures', () => {
    it('reports a missing desktop bridge as a persistent unavailable runtime', async () => {
        vi.stubGlobal('window', { electron: {} });
        const error = await rejectionOf(requestApple('library_playlists'));
        expect(error).toBeInstanceOf(OnlineProviderError);
        expect(error).toMatchObject({ code: 'unavailable', providerId: 'apple', details: { stage: 'runtime', transient: false } });
    });

    it('reports a rejected IPC call as a local unavailable failure and keeps the cause', async () => {
        const ipcFailure = new Error('IPC channel closed');
        vi.stubGlobal('window', { electron: { appleMusicRequest: vi.fn().mockRejectedValue(ipcFailure) } });
        const error = await rejectionOf(requestApple('library_playlists'));
        expect(error).toMatchObject({ code: 'unavailable', providerId: 'apple', details: { stage: 'ipc' } });
        expect(error.cause).toBe(ipcFailure);
        // IPC 故障的持久与否证实不了，不写 transient。
        expect(error.details?.transient).toBeUndefined();
    });

    it.each([
        [{ code: 'auth-required', message: 'failed with HTTP 401', httpStatus: 401 }, { code: 'auth-required', httpStatus: 401 }],
        [{ code: 'unsupported', message: 'failed with HTTP 404', httpStatus: 404 }, { code: 'unsupported', httpStatus: 404 }],
        [{ code: 'rate-limited', message: 'failed with HTTP 429', httpStatus: 429 }, { code: 'rate-limited', httpStatus: 429 }],
        [{ code: 'service-unavailable', message: 'failed with HTTP 503', httpStatus: 503 }, { code: 'service-unavailable', httpStatus: 503 }],
        [{ code: 'network', message: 'CDP Runtime.evaluate timed out' }, { code: 'network' }],
        [{ code: 'unavailable', message: 'Apple Music 浏览器不可达', reason: 'no-apple-target' },
            { code: 'unavailable', message: expect.stringContaining('no-apple-target'), details: { upstreamCode: 'unavailable' } }],
    ])('passes the bridge error %j through the Apple error table', async (bridgeError, expected) => {
        vi.stubGlobal('window', { electron: { appleMusicRequest: vi.fn().mockResolvedValue({ ok: false, error: bridgeError }) } });
        const error = await rejectionOf(requestApple('library_playlists'));
        expect(error).toBeInstanceOf(OnlineProviderError);
        expect(error).toMatchObject({ providerId: 'apple', ...expected });
    });

    it('downgrades an unrecognised bridge code instead of passing it to the UI', async () => {
        vi.stubGlobal('window', {
            electron: { appleMusicRequest: vi.fn().mockResolvedValue({ ok: false, error: { code: 'brand-new-code' } }) },
        });
        const error = await rejectionOf(requestApple('library_playlists'));
        expect(error).toMatchObject({ code: 'invalid-response', providerId: 'apple' });
        expect(error.message).toContain('brand-new-code');
    });

    it('never invents a backoff window for a throttled response', async () => {
        // 桥目前不读 Apple 的 Retry-After（页面侧 CORS 是否暴露该响应头未实测），所以不能编造。
        vi.stubGlobal('window', {
            electron: { appleMusicRequest: vi.fn().mockResolvedValue({ ok: false, error: { code: 'rate-limited', httpStatus: 429 } }) },
        });
        const error = await rejectionOf(requestApple('library_songs'));
        expect(error.retryAfterMs).toBeUndefined();
    });

    it('rejects a missing envelope rather than returning undefined as data', async () => {
        vi.stubGlobal('window', { electron: { appleMusicRequest: vi.fn().mockResolvedValue(undefined) } });
        expect(await rejectionOf(requestApple('session'))).toMatchObject({ code: 'invalid-response' });
    });
});

describe('Apple transport success path', () => {
    it('unwraps the envelope and forwards the operation and params verbatim', async () => {
        const data = { data: [{ id: 'p.1', attributes: { name: '常' } }] };
        const appleMusicRequest = vi.fn().mockResolvedValue({ ok: true, data });
        vi.stubGlobal('window', { electron: { appleMusicRequest } });
        expect(await requestApple('library_playlists', { limit: 5 })).toEqual(data);
        // limit 的 100 上限由桥统一压，transport 不再重复改写参数。
        expect(appleMusicRequest).toHaveBeenCalledWith('library_playlists', { limit: 5 });
    });
});
