import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { MotionValue } from 'framer-motion';
import { findLatestActiveLineIndex } from '../utils/appPlaybackHelpers';
import { PlayerState } from '../types';
import type { AudioBands, LyricData } from '../types';
import { setCurrentLineIndex, setPlayerState } from '../stores/usePlaybackStore';
import { selectDisplayLyrics, usePlaybackStore } from '../stores/usePlaybackStore';
import { audioBands, audioPower, currentTime, lyricCurrentTime } from '../stores/motionSignals';
import { startSystemAudioCapture, stopSystemAudioCapture } from '../services/systemAudioSpectrum';

// src/hooks/usePlaybackVisualizerBridge.ts

type UsePlaybackVisualizerBridgeParams = {

    audioRef: MutableRefObject<HTMLAudioElement | null>;
    analyserRef: MutableRefObject<AnalyserNode | null>;
    animationFrameRef: MutableRefObject<number>;
    effectiveLoopMode: 'off' | 'all' | 'one';
    isNowPlayingStageActive: boolean;
    isPlayerCapStageActive: boolean;
    stageActiveEntryKind: string | null;
    stageLyricsSession: unknown;
    stageLyricsClockRef: MutableRefObject<{
        startTimeSec: number;
        endTimeSec: number;
        baseTimeSec: number;
        startedAtMs: number | null;
    }>;
    getSyntheticStageLyricsTime: () => number;
    syncStageLyricsClock: (timeSec: number, endTimeSec: number, nextPlayerState: PlayerState, startTimeSec?: number) => void;
    getNowPlayingDisplayTime: () => number;
    getPlayerCapDisplayTime: () => number;
    syncNowPlayingClock: (progressSec: number, durationSec: number, paused: boolean) => void;
    lyricTimelineOffsetMs: number;
    /**
     * 当前曲目由外部播放器（Apple Music）发声：Folia 自己不放音，进度条与歌词读头只能跟着
     * 外部播放器的时间走。没有这条分支时，上面两个「有 audio 元素」的分支都进不去，
     * `currentLineIndex` 会一直停在 -1，歌词看着在动但永远不高亮。
     */
    isExternalPlayback: boolean;
    /**
     * 外部播放器「此刻播放到哪」，由调用方用本地单调时钟在两次进度推送之间插值得到。
     * 直接读推送值会让读头每 200ms 跳一格，看着就是卡顿。
     */
    getExternalDisplayTime: () => number;
    /** True while an automix handover is in progress and a deck other than the active one sounds. */
    isTransitionAudible: () => boolean;
    /**
     * The deck the on-screen track is playing on while a transition holds the picture, else null.
     *
     * The clock below has to follow whatever is on screen. From the moment a blend arms, the
     * active deck is seconds into the NEXT track while the title, cover and lyrics still belong to
     * the one finishing - so reading the active deck here puts the progress bar and the lyric
     * read-head near zero under a song that is three minutes in.
     */
    getDisplayElement?: () => HTMLAudioElement | null;
};

// Runs the requestAnimationFrame loop for audio-reactive visuals and lyric timing.
export function usePlaybackVisualizerBridge({
    audioRef,
    analyserRef,
    animationFrameRef,
    effectiveLoopMode,
    isNowPlayingStageActive,
    isPlayerCapStageActive,
    stageActiveEntryKind,
    stageLyricsSession,
    stageLyricsClockRef,
    getSyntheticStageLyricsTime,
    syncStageLyricsClock,
    getNowPlayingDisplayTime,
    getPlayerCapDisplayTime,
    syncNowPlayingClock,
    lyricTimelineOffsetMs,
    isTransitionAudible,
    getDisplayElement,
    isExternalPlayback,
    getExternalDisplayTime,
}: UsePlaybackVisualizerBridgeParams) {
    // Read here rather than passed in: store fields and the module-level motion signals.
    const activePlaybackContext = usePlaybackStore(state => state.activePlaybackContext);
    const playerState = usePlaybackStore(state => state.playerState);
    const duration = usePlaybackStore(state => state.duration);
    // The lyrics on screen, matching the deck getDisplayElement points at.
    const lyrics = usePlaybackStore(selectDisplayLyrics);

    const currentLineIndexRef = useRef(-1);
    // Live loopback analyser while an external player owns the sound; null when nothing is captured.
    const systemAnalyserRef = useRef<AnalyserNode | null>(null);
    // Both external-source modes share one property: no deck of their own plays the song, so the
    // spectrum has to be read from the machine's output instead of from an audio element.
    const isExternalAudioSource = isNowPlayingStageActive || isPlayerCapStageActive;

    const updateLoop = useCallback(() => {
        // Normally the active deck; the outgoing one for as long as a blend holds the picture on
        // the track it is finishing, so that clock and picture never describe different songs.
        const audioElement = getDisplayElement?.() ?? audioRef.current;
        const isActuallyPlaying = Boolean(audioElement && !audioElement.paused && !audioElement.ended);
        // Mid-handover a deck can be loading while the other one is still sounding. The analyser
        // is downstream of both, so it has real signal: dropping to the idle breath here would put
        // a visible stutter at exactly the moment meant to be seamless.
        // While an external player owns the sound there is no deck at all: the live spectrum comes
        // from the system-audio loopback capture, and that capture being live is itself the
        // audible signal - the machine may be silent, and a flat spectrum then says exactly that.
        const externalAnalyser = isExternalAudioSource ? systemAnalyserRef.current : null;
        const activeAnalyser = externalAnalyser ?? (isExternalAudioSource ? null : analyserRef.current);
        const hasAudibleSignal = isActuallyPlaying || isTransitionAudible() || externalAnalyser !== null;

        if (hasAudibleSignal && activeAnalyser) {
            const bufferLength = activeAnalyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            activeAnalyser.getByteFrequencyData(dataArray);
            audioBands.spectrum?.set(dataArray);

            const getEnergy = (minHz: number, maxHz: number): number => {
                const start = Math.floor(minHz / 21.5);
                const end = Math.floor(maxHz / 21.5);
                let sum = 0;
                for (let index = start; index <= end; index += 1) {
                    sum += dataArray[index];
                }
                const count = end - start + 1;
                return count > 0 ? sum / count : 0;
            };

            const bass = getEnergy(20, 150);
            const lowMid = getEnergy(150, 400);
            const mid = getEnergy(400, 1200);
            const vocal = getEnergy(1000, 3500);
            const treble = getEnergy(3500, 12000);

            const process = (value: number, boost = 2) => {
                const normalized = value / 255;
                return Math.pow(normalized, boost) * 255;
            };

            audioPower.set(process((bass + lowMid) / 2, 3));
            audioBands.bass.set(process(bass, 1.8));
            audioBands.lowMid.set(process(lowMid, 2));
            audioBands.mid.set(process(mid, 2));
            audioBands.vocal.set(process(vocal, 1.5));
            audioBands.treble.set(process(treble, 2));
        } else {
            const time = Date.now() / 2000;
            const breath = (Math.sin(time) + 1) * 20;
            audioPower.set(breath);
            audioBands.bass.set(breath);
            audioBands.lowMid.set(breath);
            audioBands.mid.set(breath);
            audioBands.vocal.set(breath);
            audioBands.treble.set(breath);
            audioBands.spectrum?.set(new Uint8Array(0));
        }

        if (isActuallyPlaying && audioElement) {
            const time = audioElement.currentTime;
            currentTime.set(time);

            const effectiveLyricTime = time - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            }
        } else if (isNowPlayingStageActive) {
            const nextTime = getNowPlayingDisplayTime();
            const hasReachedEnd = playerState === PlayerState.PLAYING && duration > 0 && nextTime >= duration;

            currentTime.set(nextTime);

            const effectiveLyricTime = nextTime - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            } else if (currentLineIndexRef.current !== -1) {
                currentLineIndexRef.current = -1;
                setCurrentLineIndex(-1);
            }

            if (hasReachedEnd) {
                if (effectiveLoopMode === 'one' || effectiveLoopMode === 'all') {
                    syncNowPlayingClock(0, duration, false);
                    currentTime.set(0);
                    if (lyrics) {
                        const restartedLineIndex = findLatestActiveLineIndex(lyrics.lines, 0);
                        if (restartedLineIndex !== currentLineIndexRef.current) {
                            currentLineIndexRef.current = restartedLineIndex;
                            setCurrentLineIndex(restartedLineIndex);
                        }
                    }
                } else {
                    syncNowPlayingClock(duration, duration, true);
                    setPlayerState(PlayerState.PAUSED);
                }
            }
        } else if (isExternalPlayback) {
            // 外部播放器发声、又不是舞台/PlayerCap：时间由调用方按「最近一次推送 + 本地时钟」
            // 插值给出，这里每帧都用它推进进度条与歌词读头，绝不自己发明时间。
            const nextTime = getExternalDisplayTime();

            currentTime.set(nextTime);

            const effectiveLyricTime = nextTime - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            } else if (currentLineIndexRef.current !== -1) {
                currentLineIndexRef.current = -1;
                setCurrentLineIndex(-1);
            }
        } else if (isPlayerCapStageActive) {
            // PlayerCap: clock extrapolated from progress×duration; a passive source, looping/ending is driven by the external player, so no end/loop handling here.
            const nextTime = getPlayerCapDisplayTime();
            currentTime.set(nextTime);

            const effectiveLyricTime = nextTime - lyricTimelineOffsetMs / 1000;
            lyricCurrentTime.set(effectiveLyricTime);

            if (lyrics) {
                const foundIndex = findLatestActiveLineIndex(lyrics.lines, effectiveLyricTime);
                if (foundIndex !== currentLineIndexRef.current) {
                    currentLineIndexRef.current = foundIndex;
                    setCurrentLineIndex(foundIndex);
                }
            } else if (currentLineIndexRef.current !== -1) {
                currentLineIndexRef.current = -1;
                setCurrentLineIndex(-1);
            }
        } else if (activePlaybackContext === 'stage' && stageActiveEntryKind === 'lyrics' && stageLyricsSession && lyrics) {
            const nextTime = getSyntheticStageLyricsTime();
            const clock = stageLyricsClockRef.current;
            const hasReachedEnd = playerState === PlayerState.PLAYING && nextTime >= clock.endTimeSec;

            currentTime.set(nextTime);

            const foundIndex = findLatestActiveLineIndex(lyrics.lines, nextTime);
            if (foundIndex !== currentLineIndexRef.current) {
                currentLineIndexRef.current = foundIndex;
                setCurrentLineIndex(foundIndex);
            }

            if (hasReachedEnd) {
                if (effectiveLoopMode === 'one' || effectiveLoopMode === 'all') {
                    syncStageLyricsClock(clock.startTimeSec, clock.endTimeSec, PlayerState.PLAYING, clock.startTimeSec);
                    currentTime.set(clock.startTimeSec);
                    const restartedLineIndex = findLatestActiveLineIndex(lyrics.lines, clock.startTimeSec);
                    if (restartedLineIndex !== currentLineIndexRef.current) {
                        currentLineIndexRef.current = restartedLineIndex;
                        setCurrentLineIndex(restartedLineIndex);
                    }
                } else {
                    syncStageLyricsClock(clock.endTimeSec, clock.endTimeSec, PlayerState.PAUSED, clock.startTimeSec);
                    setPlayerState(PlayerState.PAUSED);
                }
            }
        }

        animationFrameRef.current = requestAnimationFrame(updateLoop);
    }, [
        activePlaybackContext,
        analyserRef,
        animationFrameRef,
        audioBands,
        audioPower,
        audioRef,
        currentTime,
        duration,
        effectiveLoopMode,
        getNowPlayingDisplayTime,
        getPlayerCapDisplayTime,
        getSyntheticStageLyricsTime,
        isExternalAudioSource,
        isNowPlayingStageActive,
        isPlayerCapStageActive,
        lyrics,
        playerState,
        setCurrentLineIndex,
        setPlayerState,
        stageActiveEntryKind,
        stageLyricsClockRef,
        stageLyricsSession,
        syncNowPlayingClock,
        syncStageLyricsClock,
        lyricTimelineOffsetMs,
        lyricCurrentTime,
        isTransitionAudible,
        getDisplayElement,
    ]);

    // Follow the external player: capture the machine's output while an external-source mode is
    // on, and release the capture (and its single-use grant) as soon as the mode is off.
    useEffect(() => {
        if (!isExternalAudioSource) {
            systemAnalyserRef.current = null;
            void stopSystemAudioCapture();
            return;
        }

        let cancelled = false;
        void startSystemAudioCapture().then(analyser => {
            if (!cancelled) {
                systemAnalyserRef.current = analyser;
            }
        });

        return () => {
            cancelled = true;
        };
    }, [isExternalAudioSource]);

    // A capture outliving this hook would keep the loopback grant held; release it on unmount.
    useEffect(() => () => {
        void stopSystemAudioCapture();
    }, []);

    useEffect(() => {
        animationFrameRef.current = requestAnimationFrame(updateLoop);
        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, [animationFrameRef, updateLoop]);
}
