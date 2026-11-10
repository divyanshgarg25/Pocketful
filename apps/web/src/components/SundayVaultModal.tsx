import React, { useState } from 'react';
import { apiFetch, sealApproval } from '../lib/api';
import { notifyError } from '../lib/errors';
import { Badge } from './Badge';
import { ApprovalSeal } from './ApprovalSeal';
import { formatMoney } from '../lib/money';
import { useModalA11y } from '../lib/useModalA11y';
import { toast } from '../lib/toast';

interface SundayVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  amountMinor?: number;
}

export const SundayVaultModal: React.FC<SundayVaultModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  amountMinor
}) => {
  const [selectedAction, setSelectedAction] = useState<'lock_in' | 'roll_over'>('lock_in');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const leftoverMinor = amountMinor && amountMinor > 0 ? amountMinor : 3500;

  const modalRef = useModalA11y(isOpen, onClose);

  const handleSeal = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await apiFetch<{
        requiresApproval?: boolean;
        approval?: { id: string };
        message: string;
      }>('/api/vault/decide', {
        method: 'POST',
        body: JSON.stringify({
          action: selectedAction,
          amountMinor: leftoverMinor
        })
      });

      if (res.requiresApproval && res.approval?.id) {
        await sealApproval(res.approval.id, `vault_seal_${res.approval.id}_${Date.now()}`);
      }

      setSuccessMsg(res.message);
      toast.success(res.message);
      setTimeout(() => {
        onSuccess();
        onClose();
        setIsSubmitting(false);
        setSuccessMsg(null);
      }, 1000);
    } catch (err: unknown) {
      const d = notifyError(err, 'Vault decision failed');
      if (!d.silent) setErrorMsg(d.message);
      setIsSubmitting(false);
      throw err;
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4 animate-in fade-in-50"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sunday-vault-title"
        className="bg-parchment border border-oat w-full max-w-md rounded-surface p-6 sm:p-8 shadow-lift outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-ui uppercase tracking-wider text-taupe font-semibold">
                Sunday Evening Close
              </span>
              <Badge type="simulated">Simulated Vault</Badge>
            </div>
            <h3 id="sunday-vault-title" className="font-display text-xl font-semibold text-ink">
              Leftover Fun Money
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-taupe hover:text-ink text-sm p-1 rounded-[2px] focus:outline-none focus:ring-1 focus:ring-burgundy"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="mb-4 p-2.5 bg-linen border border-burgundy/30 text-burgundy text-xs rounded-[2px]"
          >
            {errorMsg}
          </div>
        )}

        {successMsg ? (
          <div className="py-8 text-center">
            <div className="w-12 h-12 bg-moss/20 text-moss rounded-full flex items-center justify-center mx-auto mb-3 text-2xl font-bold">
              ✓
            </div>
            <h4 className="font-display text-lg font-semibold text-ink mb-1">Decision Locked</h4>
            <p className="font-ui text-xs text-taupe">{successMsg}</p>
          </div>
        ) : (
          <>
            <div className="bg-sand border border-oat p-4 rounded-[2px] mb-6 text-center">
              <span className="text-xs font-ui text-taupe uppercase tracking-wider block mb-1">
                Unspent Weekend Budget
              </span>
              <span className="font-num text-4xl font-semibold text-ink block">
                {formatMoney(leftoverMinor)}
              </span>
              <span className="text-[11px] text-taupe block mt-1">
                Decide where this surplus goes before the Monday ledger resets.
              </span>
            </div>

            {/* Two Choices: Lock It In vs Roll It Over */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              <button
                type="button"
                onClick={() => setSelectedAction('lock_in')}
                className={`p-3.5 border rounded-surface text-left transition-all ${
                  selectedAction === 'lock_in'
                    ? 'border-burgundy bg-linen shadow-lift'
                    : 'border-oat bg-parchment hover:border-taupe/40'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-display font-semibold text-sm text-ink">Lock It In</span>
                  <span
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      selectedAction === 'lock_in'
                        ? 'border-burgundy bg-burgundy'
                        : 'border-taupe/40'
                    }`}
                  >
                    {selectedAction === 'lock_in' && (
                      <span className="w-1.5 h-1.5 bg-parchment rounded-full" />
                    )}
                  </span>
                </div>
                <p className="text-[11px] text-taupe font-ui leading-relaxed">
                  Sweep 100% of this unspent surplus into your Long Getaway Vault.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setSelectedAction('roll_over')}
                className={`p-3.5 border rounded-surface text-left transition-all ${
                  selectedAction === 'roll_over'
                    ? 'border-burgundy bg-linen shadow-lift'
                    : 'border-oat bg-parchment hover:border-taupe/40'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-display font-semibold text-sm text-ink">Roll Over</span>
                  <span
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                      selectedAction === 'roll_over'
                        ? 'border-burgundy bg-burgundy'
                        : 'border-taupe/40'
                    }`}
                  >
                    {selectedAction === 'roll_over' && (
                      <span className="w-1.5 h-1.5 bg-parchment rounded-full" />
                    )}
                  </span>
                </div>
                <p className="text-[11px] text-taupe font-ui leading-relaxed">
                  Add to next week's cap for a larger planned social outing.
                </p>
              </button>
            </div>

            <div className="pt-2 border-t border-oat">
              <ApprovalSeal
                onSeal={handleSeal}
                disabled={isSubmitting}
                label={isSubmitting ? 'Recording decision...' : 'Hold to seal decision'}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
