import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, RefreshCw, X, ExternalLink } from 'lucide-react';

// src/components/app/AppleLoginGuide.tsx

export interface AppleLoginGuideProps {
    phase: 'idle' | 'checking' | 'guide' | 'waiting' | 'failed';
    visible: boolean;
    browserError?: string;
    failureCode?: string;
    onStart: () => void;
    onRecheck: () => void;
    onDismiss: () => void;
}

const FAILURE_KEY: Record<string, string> = {
    'still-signed-out': 'appleLogin.failureStillSignedOut',
    'probe-failed': 'appleLogin.failureProbe',
    'bridge-unavailable': 'appleLogin.failureBridge',
    'browser-unavailable': 'appleLogin.failureNoBrowser',
    'no-browser': 'appleLogin.failureNoBrowser',
    'browser-not-ready': 'appleLogin.failureNotReady',
};

/**
 * 启动时的 Apple 登录引导卡。
 *
 * 只做提示与转发点击，所有状态都在 `useAppleLoginGate` 里 ——
 * 卡片本身不判断登录态，也不接触任何凭据输入。
 */
const AppleLoginGuide: React.FC<AppleLoginGuideProps> = ({
    phase, visible, browserError, failureCode, onStart, onRecheck, onDismiss,
}) => {
    const { t } = useTranslation();
    const primaryRef = useRef<HTMLButtonElement>(null);

    // 卡片需要用户动作时把焦点送进主按钮：键盘用户不必先 Tab 过整张墙。
    // 等待/复检阶段不给焦点，免得抢走用户正在做的事情。
    useEffect(() => {
        if (!visible) return;
        if (phase !== 'guide' && phase !== 'failed') return;
        primaryRef.current?.focus();
    }, [phase, visible]);

    if (!visible || phase === 'idle') return null;

    const failureKey = FAILURE_KEY[failureCode || browserError || ''] || 'appleLogin.failureGeneric';
    const busy = phase === 'checking';

    return (
        <div
            className="fixed right-6 bottom-24 z-50 w-[min(420px,calc(100vw-3rem))] rounded-2xl border border-white/10 bg-black/70 p-4 text-white shadow-2xl backdrop-blur-xl"
            role="dialog"
            aria-modal="false"
            aria-label={t('appleLogin.title')}
            onKeyDown={event => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                onDismiss();
            }}
        >
            <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10">
                    <Lock size={15} className="text-white/80" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-medium">{t('appleLogin.title')}</h3>
                        <button
                            type="button"
                            onClick={onDismiss}
                            className="rounded-full p-1 text-white/40 transition hover:bg-white/10 hover:text-white/80"
                            aria-label={t('appleLogin.dismiss')}
                        >
                            <X size={14} />
                        </button>
                    </div>

                    {phase === 'guide' && (
                        <ol className="mt-2 space-y-1 text-xs leading-relaxed text-white/60">
                            <li>{t('appleLogin.stepOpen')}</li>
                            <li>{t('appleLogin.stepSelf')}</li>
                            <li>{t('appleLogin.stepDone')}</li>
                        </ol>
                    )}

                    {phase === 'waiting' && (
                        <p className="mt-2 text-xs leading-relaxed text-white/60">
                            {t('appleLogin.waiting')}
                        </p>
                    )}

                    {phase === 'failed' && (
                        <p className="mt-2 text-xs leading-relaxed text-amber-300/80">
                            {t(failureKey)}
                        </p>
                    )}

                    {phase === 'checking' && (
                        <p className="mt-2 text-xs leading-relaxed text-white/60">
                            {t('appleLogin.checking')}
                        </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        {(phase === 'guide' || phase === 'failed') && (
                            <button
                                type="button"
                                ref={phase === 'guide' ? primaryRef : undefined}
                                onClick={onStart}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-black transition hover:bg-white/90"
                            >
                                <ExternalLink size={12} />
                                {phase === 'failed' ? t('appleLogin.reopenWindow') : t('appleLogin.openWindow')}
                            </button>
                        )}
                        {(phase === 'waiting' || phase === 'failed') && (
                            <button
                                type="button"
                                disabled={busy}
                                ref={phase === 'failed' ? primaryRef : undefined}
                                onClick={onRecheck}
                                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                                    phase === 'waiting'
                                        ? 'bg-white text-black hover:bg-white/90'
                                        : 'border border-white/15 text-white/80 hover:bg-white/5'
                                }`}
                            >
                                <RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />
                                {t('appleLogin.recheck')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onDismiss}
                            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 transition hover:bg-white/5 hover:text-white/80"
                        >
                            {t('appleLogin.later')}
                        </button>
                    </div>

                    <p className="mt-2 text-[11px] leading-relaxed text-white/35">
                        {t('appleLogin.privacyNote')}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default React.memo(AppleLoginGuide);
