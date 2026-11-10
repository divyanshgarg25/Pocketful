import React, { useCallback, useEffect, useState } from 'react';
import {
  addPasskey,
  beginTotpSetup,
  changePin,
  confirmTotp,
  getStepUpStatus,
  removeFactor,
  type StepUpStatus
} from '../lib/api';
import { toast } from '../lib/toast';

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cancelledQuietly = (err: unknown) => (err as { code?: string }).code === 'STEP_UP_CANCELLED';

/** Add or change the factors that approve money actions. Changing them needs an existing factor (server-enforced). */
export const SecurityCard: React.FC = () => {
  const [status, setStatus] = useState<StepUpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [totp, setTotp] = useState<{ secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStepUpStatus());
    } catch (err) {
      toast.error(`Could not load security settings: ${msg(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (err) {
      if (!cancelledQuietly(err)) toast.error(msg(err));
    } finally {
      setBusy(false);
    }
  };

  const group = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();
  const btn = 'px-3 py-1.5 rounded-lg border border-oat text-ink text-xs font-ui hover:bg-sand/30 disabled:opacity-50';

  return (
    <div className="bg-crisp-white border border-oat p-6 sm:p-8 rounded-surface shadow-lift mb-8">
      <h3 className="font-display text-lg font-semibold text-charcoal mb-2">Approval security</h3>
      <p className="text-xs text-taupe font-ui mb-4">
        Anything that moves money or deletes data needs one of these. Passkeys are the strongest; keep a second method as
        a backup. Adding or changing a method asks you to verify with one you already have.
      </p>

      {status ? (
        <ul className="text-sm text-ink font-ui mb-4 space-y-1">
          <li>Passkeys: {status.passkeys > 0 ? `${status.passkeys} registered` : 'none yet'}</li>
          <li>Authenticator app: {status.totp ? 'set up' : 'not set up'}</li>
          <li>PIN: {status.pin ? 'set' : 'not set'}</li>
          {(status.cooldownRemainingSeconds ?? 0) > 0 && (
            <li role="status" className="text-taupe">
              A method you just added or changed cannot approve money actions for another{' '}
              {Math.ceil((status.cooldownRemainingSeconds ?? 0) / 3600)} hour(s). This protects you if someone else added it.
            </li>
          )}
          {status.lockedUntil && (
            <li role="alert" className="text-maroon">
              PIN and authenticator codes are locked after too many wrong tries. Passkeys still work.
            </li>
          )}
        </ul>
      ) : (
        <p className="text-sm text-taupe mb-4">Loading…</p>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        <button type="button" disabled={busy} className={btn} onClick={() => run(addPasskey, 'Passkey added')}>
          Add a passkey
        </button>
        <button
          type="button"
          disabled={busy}
          className={btn}
          onClick={async () => {
            setBusy(true);
            try {
              setTotp(await beginTotpSetup());
              setCode('');
            } catch (err) {
              if (!cancelledQuietly(err)) toast.error(msg(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          {status?.totp ? 'Replace authenticator app' : 'Set up authenticator app'}
        </button>
        <button type="button" disabled={busy} className={btn} onClick={() => setShowPin((v) => !v)}>
          {status?.pin ? 'Change PIN' : 'Set a PIN'}
        </button>
        {status?.pin && (
          <button type="button" disabled={busy} className={btn} onClick={() => run(() => removeFactor('pin'), 'PIN removed')}>
            Remove PIN
          </button>
        )}
        {status?.totp && (
          <button type="button" disabled={busy} className={btn} onClick={() => run(() => removeFactor('totp'), 'Authenticator app removed')}>
            Remove authenticator app
          </button>
        )}
      </div>

      {totp && (
        <div className="border border-oat rounded-lg p-4 mb-4 bg-linen/50">
          <p className="text-sm text-ink mb-2">
            In your authenticator app choose “Enter a setup key” and type this key (shown once):
          </p>
          <p className="font-mono text-sm text-ink tracking-wider mb-3 select-all" data-testid="totp-secret">
            {group(totp.secret)}
          </p>
          <label htmlFor="totp-confirm" className="block text-xs text-taupe mb-1">
            Then enter the 6-digit code it shows
          </label>
          <div className="flex gap-2">
            <input
              id="totp-confirm"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="border border-oat rounded-lg px-3 py-1.5 bg-linen text-ink w-32"
            />
            <button
              type="button"
              disabled={busy || code.length !== 6}
              className={btn}
              onClick={() =>
                run(async () => {
                  await confirmTotp(code);
                  setTotp(null);
                }, 'Authenticator app ready')
              }
            >
              Confirm
            </button>
            <button type="button" className={btn} onClick={() => setTotp(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {showPin && (
        <div className="border border-oat rounded-lg p-4 bg-linen/50">
          <label htmlFor="new-pin" className="block text-xs text-taupe mb-1">
            New PIN (6–12 digits, not repeated or sequential)
          </label>
          <div className="flex gap-2">
            <input
              id="new-pin"
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={12}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              className="border border-oat rounded-lg px-3 py-1.5 bg-linen text-ink w-40"
            />
            <button
              type="button"
              disabled={busy || newPin.length < 6}
              className={btn}
              onClick={() =>
                run(async () => {
                  await changePin(newPin);
                  setNewPin('');
                  setShowPin(false);
                }, 'PIN saved')
              }
            >
              Save PIN
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
