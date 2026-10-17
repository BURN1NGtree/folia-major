import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppleLibrary } from '@/hooks/useAppleLibrary';
import { useOnlineProviderAccountStore } from '@/stores/useOnlineProviderAccountStore';
import { OnlineProviderError } from '@/types/onlineMusic';

// test/unit/hooks/useAppleLibrary.test.ts

const mocks = vi.hoisted(() => ({
    effects: [] as Array<() => unknown>,
    getProviderAvailability: vi.fn(),
    getLoginStatus: vi.fn(),
    getProviderUserPlaylists: vi.fn(),
    logout: vi.fn(),
    loadProviderAccountSnapshot: vi.fn(),
    clearProviderAccountSnapshot: vi.fn(),
    saveProviderAccountSnapshot: vi.fn(),
}));
// 与 test/unit/hooks/useBodianLibrary.test.ts 同一套做法：hook 逻辑在 node 环境里直接驱动。
vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => { mocks.effects.push(effect); },
}));
vi.mock('@/services/onlineMusic/omni', () => ({ omni: mocks }));
vi.mock('@/services/onlineMusic/providerAccountCache', () => mocks);

const playlist = (id: string, name: string) => ({ providerId: 'apple', id, name, type: 'playlist' });
const THE_USER = { id: 'me', nickname: 'Apple Music (CN)' };

const account = () => useOnlineProviderAccountStore.getState().accounts.apple;

describe('Apple Music 曲库水合', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.effects.length = 0;
        mocks.getProviderAvailability.mockReturnValue({ configured: true });
        mocks.getLoginStatus.mockResolvedValue(THE_USER);
        mocks.getProviderUserPlaylists.mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
        mocks.clearProviderAccountSnapshot.mockResolvedValue(undefined);
        mocks.loadProviderAccountSnapshot.mockResolvedValue(null);
        mocks.saveProviderAccountSnapshot.mockResolvedValue({ savedAt: 1234 });
        mocks.logout.mockResolvedValue(undefined);
        useOnlineProviderAccountStore.setState({ accounts: {} });
    });

    it('挂载时先同步清掉上一次的账户，再去问浏览器当前是谁', async () => {
        useOnlineProviderAccountStore.getState().updateAccount('apple', {
            status: 'authenticated',
            user: { id: 'me', nickname: 'Apple Music (CN)' },
            collections: [playlist('p.old', '上一次的歌单')],
        });

        useAppleLibrary();
        mocks.effects[0]();

        // 关键：旧歌单不能在新会话确认之前先显示出来。
        expect(account()).toMatchObject({ status: 'anonymous', user: null, collections: [] });
        await vi.waitFor(() => expect(mocks.saveProviderAccountSnapshot).toHaveBeenCalled());
    });

    it('桥不可用（浏览器没开/没有 Apple Music 标签页）时视为不可用，而不是未登录', async () => {
        mocks.getProviderAvailability.mockReturnValue({ configured: false, reason: 'runtime-unavailable' });

        const { refresh } = useAppleLibrary();
        await expect(refresh()).resolves.toBe(false);

        // 不去问登录态：连不上页面时那一定会失败，问了只会把「桥断了」错报成「登出了」。
        expect(mocks.getLoginStatus).not.toHaveBeenCalled();
        expect(mocks.saveProviderAccountSnapshot).not.toHaveBeenCalled();
        expect(account().status).not.toBe('authenticated');
    });

    it('已登录时把歌单写进账户并落盘', async () => {
        mocks.getProviderUserPlaylists.mockResolvedValue({
            items: [playlist('p.1', '常'), playlist('p.2', '华语经典')],
            hasMore: false,
            nextOffset: 2,
        });

        const { refresh } = useAppleLibrary();
        await expect(refresh()).resolves.toBe(true);

        expect(account()).toMatchObject({ status: 'authenticated', user: THE_USER, freshness: 'fresh' });
        expect(account().collections.map(collection => collection.name)).toEqual(['常', '华语经典']);
        expect(mocks.saveProviderAccountSnapshot).toHaveBeenCalledWith('apple', expect.objectContaining({
            user: THE_USER,
            collections: [expect.objectContaining({ name: '常' }), expect.objectContaining({ name: '华语经典' })],
            likedSongIds: [],
        }));
    });

    it('浏览器里没登录时清干净，并把旧快照一并删掉', async () => {
        mocks.getLoginStatus.mockResolvedValue(null);
        useOnlineProviderAccountStore.getState().updateAccount('apple', {
            status: 'authenticated', user: THE_USER, collections: [playlist('p.old', '旧')],
        });

        const { refresh } = useAppleLibrary();
        await expect(refresh()).resolves.toBe(false);

        expect(account()).toMatchObject({ status: 'anonymous', user: null, collections: [] });
        expect(mocks.clearProviderAccountSnapshot).toHaveBeenCalledWith('apple');
        expect(mocks.getProviderUserPlaylists).not.toHaveBeenCalled();
    });

    it('不推进 offset 的分页必须自己停（上游回 hasMore 也不能转圈）', async () => {
        mocks.getProviderUserPlaylists.mockResolvedValue({
            items: [playlist('p.1', '只此一页')],
            hasMore: true,
            nextOffset: 0,
        });

        const { refresh } = useAppleLibrary();
        await expect(refresh()).resolves.toBe(true);

        expect(mocks.getProviderUserPlaylists).toHaveBeenCalledTimes(1);
        expect(account().collections).toHaveLength(1);
    });

    it('令牌过期（auth-required）清账户，其它失败保留已登录用户只标错误', async () => {
        const { refresh } = useAppleLibrary();
        await refresh();
        expect(account().status).toBe('authenticated');

        mocks.getProviderUserPlaylists.mockRejectedValue(new OnlineProviderError('auth-required', 'expired', 'apple'));
        await expect(refresh()).resolves.toBe(false);
        expect(account()).toMatchObject({ status: 'anonymous', user: null });

        // 浏览器里重新登录后，一次刷新就该回到已登录。
        mocks.getProviderUserPlaylists.mockResolvedValue({ items: [], hasMore: false, nextOffset: 0 });
        await refresh();
        expect(account().status).toBe('authenticated');

        // 浏览器被关掉之类的失败：不能因为一次取数失败就把用户踢下线。
        mocks.getProviderUserPlaylists.mockRejectedValue(new Error('browser closed'));
        await expect(refresh()).resolves.toBe(false);
        expect(account()).toMatchObject({ status: 'authenticated', freshness: 'error', error: 'apple-refresh-failed' });
    });

    it('logout 清本地绑定，且不会去动浏览器里的 Apple 会话', async () => {
        const { refresh, logout } = useAppleLibrary();
        await refresh();
        expect(account().status).toBe('authenticated');

        await logout();

        expect(account()).toMatchObject({ status: 'anonymous', user: null, collections: [] });
        expect(mocks.clearProviderAccountSnapshot).toHaveBeenCalledWith('apple');
        // provider 侧的 logout 是空实现，这里只断言它被调用过：真正的登出不归 Folia 管。
        expect(mocks.logout).toHaveBeenCalledWith('apple');
    });
});
