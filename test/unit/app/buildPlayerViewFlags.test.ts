// test/unit/app/buildPlayerViewFlags.test.ts

import { describe, expect, it } from 'vitest';
import { buildPlayerViewFlags } from '@/components/app/presentation/buildPlayerViewFlags';

const base = {
    currentView: 'player',
    disableHomeDynamicBackground: false,
    hidePlayerProgressBar: false,
    hidePlayerTranslationSubtitle: false,
    hidePlayerRightPanelButton: false,
    isNowPlayingControlDisabled: false,
    activePlaybackContext: 'main' as const,
    stageActiveEntryKind: null,
    audioSrc: null,
    duration: 0,
};

describe('buildPlayerViewFlags 的播放键可用性', () => {
    it('有音频流时可用', () => {
        const flags = buildPlayerViewFlags({ ...base, audioSrc: 'http://x/a.mp3', duration: 200 });
        expect(flags.canToggleCurrentPlayback).toBe(true);
    });

    it('既没有流也没有外部目标时不可用', () => {
        // 这就是 Apple 曲目在 Folia 里的原状：没有可播的流，所以「播放」按钮本来是灰的。
        const flags = buildPlayerViewFlags(base);
        expect(flags.canToggleCurrentPlayback).toBe(false);
    });

    it('外部源在场时仍可用：按钮打给外部播放器，而不是本地播放器', () => {
        const external = buildPlayerViewFlags({ ...base, isNowPlayingControlDisabled: true, hasExternalPlaybackTarget: true });
        expect(external.canToggleCurrentPlayback).toBe(true);
    });

    it('Apple 曲目（无流、无舞台）也能点：交给 Apple Music 去播', () => {
        const apple = buildPlayerViewFlags({ ...base, hasExternalPlaybackTarget: true });
        expect(apple.canToggleCurrentPlayback).toBe(true);
    });

    it('没有外部目标时，外部控制禁用标记依旧会关掉按钮', () => {
        const flags = buildPlayerViewFlags({ ...base, isNowPlayingControlDisabled: true });
        expect(flags.canToggleCurrentPlayback).toBe(false);
    });
});
