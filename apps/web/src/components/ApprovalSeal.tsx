import React, { useState, useRef, useEffect } from 'react';

export interface ApprovalSealProps {
  onSeal?: () => Promise<boolean | void> | boolean | void;
  onApprove?: () => Promise<boolean | void> | boolean | void;
  disabled?: boolean;
  label?: string;
  size?: number; // default 72px
  expiresAt?: string; // Optional ISO expiration timestamp for 10-minute TTL
  stepUpPrompt?: string;
  onStepUp?: (proof: string) => Promise<boolean | void> | boolean | void;
}

export const ApprovalSeal: React.FC<ApprovalSealProps> = ({
  onSeal,
  onApprove,
  disabled = false,
  label = 'Hold to seal approval',
  size = 72,
  expiresAt,
  stepUpPrompt,
  onStepUp
}) => {
  const [isHolding, setIsHolding] = useState(false);
  const [isSealing, setIsSealing] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [sealFailed, setSealFailed] = useState(false);
  const [accessibleConfirmed, setAccessibleConfirmed] = useState(false);
  const [stepUpInput, setStepUpInput] = useState('');
  const [showStepUpModal, setShowStepUpModal] = useState(false);

  const timerRef = useRef<number | null>(null);
  const HOLD_DURATION_MS = 1200; // 1.2 seconds press-and-hold

  // Detect user preference for reduced motion
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 10-minute TTL countdown timer
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => {
    if (expiresAt) {
      const diff = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000);
      return Math.max(0, diff);
    }
    return 600; // 10 minutes default
  });

  const isExpired = secondsRemaining <= 0;

  useEffect(() => {
    if (completed || disabled || isExpired) return;
    const interval = setInterval(() => {
      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [completed, disabled, isExpired]);

  const formatCountdown = (totalSec: number) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const executeApprovalAction = async (proof?: string) => {
    try {
      setIsSealing(true);
      setSealFailed(false);

      if (proof && onStepUp) {
        const res = await onStepUp(proof);
        if (res === false) throw new Error('Verification failed');
      }

      if (onSeal) {
        const res = await onSeal();
        if (res === false) throw new Error('Seal was not completed');
      }

      if (onApprove) {
        const res = await onApprove();
        if (res === false) throw new Error('Approval was not completed');
      }

      setCompleted(true);
      setSealFailed(false);
    } catch {
      setCompleted(false);
      setSealFailed(true);
      setAccessibleConfirmed(false);
    } finally {
      setIsSealing(false);
      setIsHolding(false);
    }
  };

  const triggerApproval = () => {
    if (stepUpPrompt && onStepUp) {
      setShowStepUpModal(true);
      return;
    }
    void executeApprovalAction();
  };

  const handleStepUpConfirm = () => {
    if (!stepUpInput.trim()) return;
    const proof = stepUpInput.trim();
    setShowStepUpModal(false);
    void executeApprovalAction(proof);
  };

  const handleStepUpCancel = () => {
    setShowStepUpModal(false);
    setSealFailed(true);
    setCompleted(false);
    setIsHolding(false);
  };

  const startHold = (e?: React.PointerEvent | React.KeyboardEvent) => {
    if (e && 'button' in e && e.button !== 0) return;
    if (disabled || completed || isHolding || isExpired || isSealing) return;

    if (sealFailed) {
      setSealFailed(false);
    }

    // Motor accessibility & reduced motion: seal immediately without hold delay
    if (prefersReducedMotion) {
      triggerApproval();
      return;
    }

    setIsHolding(true);

    timerRef.current = window.setTimeout(() => {
      setIsHolding(false);
      timerRef.current = null;
      triggerApproval();
    }, HOLD_DURATION_MS);
  };

  const cancelHold = () => {
    if (completed || isSealing) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsHolding(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if ((disabled || isExpired) && isHolding) {
      cancelHold();
    }
  }, [disabled, isExpired, isHolding]);

  const radius = size / 2 - 4;
  const circumference = 2 * Math.PI * radius;

  const effectiveDisabled = disabled || isExpired || isSealing;

  return (
    <div className="flex flex-col items-center gap-3 select-none">
      {/* Screen-reader Live Region */}
      <div aria-live="polite" className="sr-only">
        {completed
          ? 'Approval seal successfully stamped'
          : isSealing
          ? 'Sealing approval...'
          : sealFailed
          ? 'Approval not sealed. You can hold to wax again.'
          : isHolding
          ? 'Holding to seal approval...'
          : isExpired
          ? 'Approval challenge expired'
          : label}
      </div>

      <div
        className={`relative touch-none select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-maroon focus-visible:ring-offset-2 rounded-full ${
          effectiveDisabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
        }`}
        onPointerDown={startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!isHolding && !completed && !effectiveDisabled && !e.repeat) {
              startHold(e);
            }
          }
        }}
        onKeyUp={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!completed) {
              cancelHold();
            }
          }
        }}
        role="button"
        tabIndex={effectiveDisabled ? -1 : 0}
        aria-label={isExpired ? 'Approval expired' : label}
        aria-disabled={effectiveDisabled}
        aria-pressed={isHolding}
      >
        {/* SVG Progress Ring */}
        <svg width={size} height={size} className="transform -rotate-90">
          {/* Brass outer ring track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            className="stroke-brass"
            strokeWidth="2.5"
            fill="none"
            opacity="0.4"
          />
          {/* Clockwise filling ink ring */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            className="stroke-burgundy"
            strokeWidth="3.5"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            style={{
              strokeDashoffset: isHolding || completed || isSealing ? 0 : circumference,
              transition:
                isHolding && !prefersReducedMotion
                  ? `stroke-dashoffset ${HOLD_DURATION_MS}ms linear`
                  : 'none'
            }}
          />
        </svg>

        {/* Center Wax Seal Stamp */}
        <div
          style={{ width: size - 14, height: size - 14 }}
          className={`absolute inset-0 m-auto rounded-full bg-burgundy flex items-center justify-center transition-all duration-200 border border-brass shadow-lift ${
            isHolding || isSealing ? 'scale-95 rotate-2 bg-maroon' : 'hover:bg-claret'
          } ${completed ? 'scale-90 bg-maroon' : ''} ${
            effectiveDisabled ? 'opacity-50 cursor-not-allowed' : ''
          }`}
        >
          <span
            className={`font-display italic text-parchment font-bold select-none leading-none pb-0.5 ${
              size < 64 ? 'text-lg' : 'text-2xl'
            }`}
          >
            {completed ? '✓' : isExpired ? '✕' : isSealing ? '·' : 'p'}
          </span>
        </div>
      </div>

      {/* Status Label & Countdown Timer */}
      <div className="text-center font-ui">
        <p className="text-xs text-taupe tracking-wide">
          {completed
            ? 'Seal Approved'
            : isSealing
            ? 'Sealing...'
            : sealFailed
            ? 'Not sealed · Hold or tap to wax again'
            : isHolding
            ? 'Holding...'
            : isExpired
            ? 'Approval Expired'
            : label}
        </p>
        {!completed && (
          <span
            className={`text-[10px] tracking-wider font-mono block mt-0.5 ${
              isExpired
                ? 'text-burgundy font-bold'
                : secondsRemaining < 60
                ? 'text-burgundy'
                : 'text-taupe'
            }`}
          >
            {isExpired ? 'Time limit reached' : `TTL: ${formatCountdown(secondsRemaining)}`}
          </span>
        )}
      </div>

      {/* Option to Wax Again when seal did not complete */}
      {sealFailed && !completed && !effectiveDisabled && (
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setSealFailed(false);
              triggerApproval();
            }}
            className="px-3 py-1 bg-burgundy text-parchment text-xs font-ui rounded-[2px] hover:bg-claret active:bg-maroon transition-colors shadow-lift font-medium"
          >
            Wax Again
          </button>
        </div>
      )}

      {/* Accessible Non-Hold Button Alternative */}
      <div className="mt-1 flex items-center gap-2 text-xs text-taupe sm:flex">
        <label className="flex items-center gap-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={accessibleConfirmed}
            onChange={(e) => setAccessibleConfirmed(e.target.checked)}
            className="accent-burgundy rounded-[2px]"
            disabled={effectiveDisabled || completed}
          />
          <span>I have reviewed this</span>
        </label>
        <button
          type="button"
          disabled={!accessibleConfirmed || effectiveDisabled || completed}
          onClick={() => {
            setIsHolding(false);
            triggerApproval();
          }}
          className={`px-2.5 py-1 text-xs border rounded-[2px] transition-colors ${
            accessibleConfirmed && !effectiveDisabled && !completed
              ? 'bg-burgundy text-parchment border-burgundy hover:bg-claret shadow-lift'
              : 'bg-sand text-taupe border-oat cursor-not-allowed'
          }`}
        >
          Approve
        </button>
      </div>

      {/* Step-Up Challenge Modal */}
      {showStepUpModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="step-up-title"
          className="fixed inset-0 bg-ink/50 z-[90] flex items-center justify-center p-4"
        >
          <div className="bg-parchment border border-brass p-6 rounded-surface max-w-sm w-full shadow-lift">
            <h3 id="step-up-title" className="font-display font-semibold text-sm text-ink mb-2">
              Guardian Verification Required
            </h3>
            <p className="text-xs text-taupe font-ui mb-4 leading-relaxed">
              {stepUpPrompt || 'Please enter confirmation proof to complete this high-impact action.'}
            </p>
            <input
              type="text"
              value={stepUpInput}
              onChange={(e) => setStepUpInput(e.target.value)}
              placeholder="Enter confirmation code"
              className="w-full text-xs font-mono p-2 border border-oat rounded-[2px] mb-4 bg-linen focus:border-burgundy focus:outline-none"
              autoFocus
            />
            <div className="flex justify-end gap-2 text-xs font-ui">
              <button
                type="button"
                onClick={handleStepUpCancel}
                className="px-3 py-1.5 text-taupe hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!stepUpInput.trim()}
                onClick={handleStepUpConfirm}
                className="px-3 py-1.5 bg-burgundy text-parchment rounded-[2px] disabled:opacity-50"
              >
                Verify & Seal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
