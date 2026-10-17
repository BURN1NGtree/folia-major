import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/electron/nowplayingSupervisor.test.ts — 内置 now-playing 服务监管者的启停规则。
// 全程注入 fork 与端口探测：不启动真实进程、不连 9863，也不 require('electron')。

const require = createRequire(import.meta.url);
const { createNowPlayingSupervisor, RESTART_DELAYS_MS } = require('../../../electron/nowplaying/supervisor.cjs');

/** 假的 utilityProcess：只带监管者会用到的成员（pid/kill/stdio/exit）。 */
function createFakeChild(pid: number) {
    const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
    };
    child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    return child;
}

function createHarness(options: { portBusy?: boolean } = {}) {
    const children: ReturnType<typeof createFakeChild>[] = [];
    const fork = vi.fn(() => {
        const child = createFakeChild(1000 + children.length);
        children.push(child);
        return child;
    });
    const probePort = vi.fn(async () => Boolean(options.portBusy));
    const supervisor = createNowPlayingSupervisor({ fork, probePort, log: () => {} });
    return { supervisor, fork, probePort, children };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('createNowPlayingSupervisor', () => {
    it('首次 ensureStarted 只拉起一次，并发调用不会重复 fork', async () => {
        const { supervisor, fork, children } = createHarness();
        await Promise.all([supervisor.ensureStarted('a'), supervisor.ensureStarted('b')]);

        expect(fork).toHaveBeenCalledTimes(1);
        expect(children).toHaveLength(1);
        expect(supervisor.status()).toMatchObject({ state: 'running', pid: 1000 });
    });

    it('端口已被外部服务占用时不 fork，并保持 external', async () => {
        const { supervisor, fork } = createHarness({ portBusy: true });
        await supervisor.ensureStarted('busy');
        await supervisor.ensureStarted('busy-again');

        expect(fork).not.toHaveBeenCalled();
        expect(supervisor.status().state).toBe('external');
    });

    it('子进程崩溃后按退避重启', async () => {
        vi.useFakeTimers();
        const { supervisor, fork, children } = createHarness();
        await supervisor.ensureStarted('start');
        expect(fork).toHaveBeenCalledTimes(1);

        children[0].emit('exit', 1);
        // handleExit 先探端口（微任务），再排定时器
        await vi.advanceTimersByTimeAsync(0);
        expect(supervisor.status()).toMatchObject({ state: 'restarting', restartIndex: 1 });

        await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[0]);
        expect(fork).toHaveBeenCalledTimes(2);
        expect(supervisor.status().state).toBe('running');
    });

    it('连续崩溃时退避递增并封顶在最后一档', async () => {
        vi.useFakeTimers();
        const { supervisor, fork, children } = createHarness();
        await supervisor.ensureStarted('start');

        for (let index = 0; index < RESTART_DELAYS_MS.length; index += 1) {
            children[index].emit('exit', 1);
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS[index]);
        }
        expect(supervisor.status().restartIndex).toBe(RESTART_DELAYS_MS.length);

        children[RESTART_DELAYS_MS.length].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(0);
        // 退避停在最后一档，不会越界
        await vi.advanceTimersByTimeAsync(RESTART_DELAYS_MS.at(-1));
        expect(fork).toHaveBeenCalledTimes(RESTART_DELAYS_MS.length + 2);
    });

    it('崩溃时端口已被外部接管，则不再重启', async () => {
        vi.useFakeTimers();
        const { supervisor, fork, probePort, children } = createHarness();
        await supervisor.ensureStarted('start');

        probePort.mockResolvedValue(true);
        children[0].emit('exit', 0);
        await vi.advanceTimersByTimeAsync(0);

        expect(supervisor.status().state).toBe('external');
        await vi.advanceTimersByTimeAsync(30_000);
        expect(fork).toHaveBeenCalledTimes(1);
    });

    it('stop() 杀掉子进程并取消待执行的重启', async () => {
        vi.useFakeTimers();
        const { supervisor, fork, children } = createHarness();
        await supervisor.ensureStarted('start');
        children[0].emit('exit', 1);
        await vi.advanceTimersByTimeAsync(0);

        supervisor.stop();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(fork).toHaveBeenCalledTimes(1);
        expect(supervisor.status().state).toBe('stopped');
    });

    it('stop() 会 kill 正在运行的子进程', async () => {
        const { supervisor, children } = createHarness();
        await supervisor.ensureStarted('start');
        supervisor.stop();
        expect(children[0].kill).toHaveBeenCalled();
    });
});
