// src/services/systemAudioSpectrum.ts
//
// System-audio loopback analyser.
//
// When the sound comes from another application (Apple Music playing the real, DRM-protected
// track), Folia has no audio element to read: the deck analyser stays silent and the visualizer
// would fall back to its idle breath. This service captures what the machine is actually
// outputting - through the main process, which grants a single-use loopback stream - and exposes
// it as an AnalyserNode the visualizer can read.
//
// The captured signal is only ever connected to the analyser. It is deliberately NOT connected to
// the audio destination, because routing a loopback stream back to the output would echo the
// machine's own sound. Nothing here records, stores or forwards audio.

const FFT_SIZE = 2048;

type LoopbackBridge = NonNullable<Window['electron']>;

type SystemAudioCapture = {
    stream: MediaStream;
    context: AudioContext;
    analyser: AnalyserNode;
};

let capture: SystemAudioCapture | null = null;
let pending: Promise<AnalyserNode | null> | null = null;

/**
 * The preload bridge, or null outside Electron / on a preload that predates these channels
 * (so an older build degrades to the idle visuals instead of throwing).
 */
function getLoopbackBridge(): LoopbackBridge | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const bridge = window.electron;
    if (
        !bridge
        || typeof bridge.armSystemAudioLoopback !== 'function'
        || typeof bridge.disarmSystemAudioLoopback !== 'function'
    ) {
        return null;
    }

    return bridge;
}

/** The live loopback analyser, or null while no capture is running. */
export function getSystemAudioAnalyser(): AnalyserNode | null {
    return capture?.analyser ?? null;
}

export function isSystemAudioCaptureActive(): boolean {
    return capture !== null;
}

/**
 * Starts (or joins) the loopback capture and resolves with its analyser.
 *
 * Resolves null - never throws - when the platform refuses the capture, so callers can fall back
 * to the idle visuals. The video track exists only because Chromium refuses an audio-only display
 * capture, and it is stopped immediately: nothing is ever drawn from it.
 */
export async function startSystemAudioCapture(): Promise<AnalyserNode | null> {
    if (capture) {
        return capture.analyser;
    }

    if (pending) {
        return pending;
    }

    const bridge = getLoopbackBridge();
    if (!bridge) {
        return null;
    }

    pending = (async () => {
        try {
            // Single-use grant: the main process consumes it for the next display-media request.
            await bridge.armSystemAudioLoopback();

            // The loopback signal drives a spectrum, not a call. Gain control would flatten the
            // dynamics the bars are meant to show, and echo cancellation can mistake the music
            // itself for echo and hollow it out - Chromium enables all three by default.
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                    autoGainControl: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                },
            });
            stream.getVideoTracks().forEach(track => track.stop());

            if (stream.getAudioTracks().length === 0) {
                stream.getTracks().forEach(track => track.stop());
                return null;
            }

            const context = new AudioContext();
            const source = context.createMediaStreamSource(stream);
            const analyser = context.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            source.connect(analyser);

            capture = { stream, context, analyser };
            return analyser;
        } catch (error) {
            console.warn('[SystemAudio] loopback capture unavailable:', error);
            return null;
        } finally {
            pending = null;
        }
    })();

    return pending;
}

/** Stops the capture, releases the grant and closes the context. Safe to call when idle. */
export async function stopSystemAudioCapture(): Promise<void> {
    const current = capture;
    if (!current) {
        return;
    }

    capture = null;
    current.stream.getTracks().forEach(track => track.stop());

    try {
        await current.context.close();
    } catch {
        // Already closed - nothing to release.
    }

    const bridge = getLoopbackBridge();
    if (bridge) {
        try {
            await bridge.disarmSystemAudioLoopback();
        } catch {
            // The grant is single-use anyway; a failed disarm only affects the next arm.
        }
    }
}
