import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  registerStepUpPrompter,
  type StepUpMethod,
  type StepUpPromptRequest,
  type StepUpPromptResult
} from '../lib/api';
import { useModalA11y } from '../lib/useModalA11y';

interface Pending {
  req: StepUpPromptRequest;
  resolve: (r: StepUpPromptResult | null) => void;
}

const PIN_RE = /^\d{6,12}$/;
const CODE_RE = /^\d{6}$/;
const METHOD_LABEL: Record<StepUpMethod, string> = { passkey: 'Passkey', totp: 'Authenticator app', pin: 'PIN' };

/** Single mounted modal that collects the step-up proof for any approval flow. */
export const StepUpPromptHost: React.FC = () => {
  const [pending, setPending] = useState<Pending | null>(null);
  const [method, setMethod] = useState<StepUpMethod>('pin');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [usePinToEnroll, setUsePinToEnroll] = useState(false);
  const [error, setError] = useState('');
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  useEffect(() => {
    registerStepUpPrompter(
      (req) =>
        new Promise<StepUpPromptResult | null>((resolve) => {
          setPin('');
          setConfirm('');
          setCode('');
          setError('');
          setUsePinToEnroll(false);
          if (req.mode === 'verify') {
            const first =
              req.passkeySupported && req.methods.includes('passkey')
                ? 'passkey'
                : req.methods.find((m) => m !== 'passkey') ?? 'pin';
            setMethod(first);
          }
          setPending({ req, resolve });
        })
    );
    return () => registerStepUpPrompter(null);
  }, []);

  const close = useCallback((value: StepUpPromptResult | null) => {
    pendingRef.current?.resolve(value);
    setPending(null);
    setPin('');
    setConfirm('');
    setCode('');
  }, []);

  const handleClose = useCallback(() => close(null), [close]);
  const containerRef = useModalA11y(!!pending, handleClose);

  if (!pending) return null;
  const { req } = pending;
  const enrolling = req.mode === 'enroll';
  const showPinForm = enrolling ? usePinToEnroll || !req.passkeySupported : method === 'pin';

  const submit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (showPinForm) {
      if (!PIN_RE.test(pin)) return setError('Use 6–12 digits.');
      if (enrolling && pin !== confirm) return setError('PINs do not match.');
      return close({ method: 'pin', pin });
    }
    if (!enrolling && method === 'totp') {
      if (!CODE_RE.test(code)) return setError('Enter the 6-digit code from your authenticator app.');
      return close({ method: 'totp', code });
    }
    close({ method: 'passkey' });
  };

  const verifyMethods = req.mode === 'verify' ? req.methods.filter((m) => m !== 'passkey' || req.passkeySupported) : [];

  const title = enrolling ? 'Secure your approvals' : 'Confirm it is really you';
  const intro = enrolling
    ? 'Approving anything that moves money or deletes data needs a second check that a stolen login cannot pass. A passkey uses your device’s fingerprint, face or screen lock.'
    : 'Verify before this action runs. This check is tied to this exact approval and works only once.';

  return (
    <div className="fixed inset-0 bg-ink/40 z-[60] flex items-center justify-center p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="stepup-title"
        className="bg-parchment border border-oat rounded-surface shadow-lift w-full max-w-sm p-6"
      >
        <h2 id="stepup-title" className="font-display text-xl text-ink mb-1">
          {title}
        </h2>
        <p className="text-sm text-taupe mb-4">{intro}</p>

        {!enrolling && verifyMethods.length > 1 && (
          <div role="tablist" aria-label="Verification method" className="flex gap-1 mb-4">
            {verifyMethods.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                onClick={() => {
                  setMethod(m);
                  setError('');
                }}
                className={`flex-1 px-2 py-1.5 rounded-lg border text-xs ${
                  method === m ? 'bg-burgundy text-parchment border-burgundy' : 'border-oat text-ink'
                }`}
              >
                {METHOD_LABEL[m]}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={submit} noValidate>
          {showPinForm && (
            <>
              <label className="block text-sm text-ink mb-1" htmlFor="pin-input">
                {enrolling ? 'Choose a PIN' : 'PIN'}
              </label>
              <input
                id="pin-input"
                type="password"
                inputMode="numeric"
                autoComplete={enrolling ? 'new-password' : 'current-password'}
                maxLength={12}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                aria-invalid={!!error}
                aria-describedby={error ? 'stepup-error' : undefined}
                className="w-full border border-oat rounded-lg px-3 py-2 bg-linen text-ink mb-3"
              />
              {enrolling && (
                <>
                  <label className="block text-sm text-ink mb-1" htmlFor="pin-confirm">
                    Confirm PIN
                  </label>
                  <input
                    id="pin-confirm"
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={12}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
                    className="w-full border border-oat rounded-lg px-3 py-2 bg-linen text-ink mb-3"
                  />
                </>
              )}
            </>
          )}

          {!enrolling && method === 'totp' && (
            <>
              <label className="block text-sm text-ink mb-1" htmlFor="totp-input">
                6-digit code
              </label>
              <input
                id="totp-input"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                aria-invalid={!!error}
                aria-describedby={error ? 'stepup-error' : undefined}
                className="w-full border border-oat rounded-lg px-3 py-2 bg-linen text-ink mb-3"
              />
            </>
          )}

          {!showPinForm && (enrolling || method === 'passkey') && (
            <p className="text-sm text-ink mb-3">
              {enrolling ? 'Your device will ask you to create a passkey.' : 'Your device will ask you to confirm with your passkey.'}
            </p>
          )}

          {error && (
            <p id="stepup-error" role="alert" className="text-sm text-maroon mb-3">
              {error}
            </p>
          )}

          <div className="flex gap-2 justify-end items-center">
            {enrolling && req.passkeySupported && (
              <button
                type="button"
                onClick={() => {
                  setUsePinToEnroll((v) => !v);
                  setError('');
                }}
                className="mr-auto text-xs text-brick underline"
              >
                {usePinToEnroll ? 'Use a passkey instead' : 'Use a PIN instead'}
              </button>
            )}
            <button type="button" onClick={() => close(null)} className="px-4 py-2 rounded-lg border border-oat text-ink">
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-burgundy text-parchment">
              {enrolling ? (showPinForm ? 'Save PIN' : 'Create passkey') : method === 'passkey' ? 'Use passkey' : 'Approve'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
