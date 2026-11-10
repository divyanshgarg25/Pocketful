import { logError } from '../lib/log';
import { notifyError } from '../lib/errors';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { LedgerRule } from '../components/LedgerRule';
import { Badge } from '../components/Badge';
import { RuledPlaceholder } from '../components/RuledPlaceholder';
import { toast } from '../lib/toast';

interface FriendPayScreenProps {
  token: string;
  onBackToApp?: () => void;
}

interface PayPageData {
  friendName: string;
  organizerName: string;
  venueName: string;
  shareMinor: number;
  shareFormatted: string;
  currency: string;
  deadline: string;
  status: string;
  groupStatus?: string;
  payUrl: string | null;
  paidFriends: string[];
  isGroupConfirmed: boolean;
}

export const FriendPayScreen: React.FC<FriendPayScreenProps> = ({ token, onBackToApp }) => {
  const [data, setData] = useState<PayPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [paidSuccess, setPaidSuccess] = useState(false);

  const fetchDetails = async () => {
    try {
      const res = await apiFetch<PayPageData>(`/pay/${token}`);
      setData(res);
      if (res.status === 'paid') {
        setPaidSuccess(true);
      }
    } catch (err) {
      logError('Failed to load friend pay page:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetails();
  }, [token]);

  const handlePay = async () => {
    setPaying(true);
    try {
      await apiFetch(`/pay/${token}/capture`, { method: 'POST' });
      setPaidSuccess(true);
      await fetchDetails();
      toast.success('Payment captured');
    } catch (err: unknown) {
      notifyError(err, 'Payment error');
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-linen flex items-center justify-center p-4">
        <RuledPlaceholder message="Opening secure friend checkout statement..." rows={2} className="w-full max-w-lg" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-linen flex items-center justify-center p-4">
        <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift text-center max-w-md">
          <p className="font-ui text-brick text-sm mb-2">Invitation link not found or expired.</p>
          {onBackToApp && (
            <button
              type="button"
              onClick={onBackToApp}
              className="text-xs text-taupe underline hover:text-ink"
            >
              Return to Ledger
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-linen flex items-center justify-center p-4">
      <div className="bg-parchment border border-oat w-full max-w-lg rounded-surface p-6 sm:p-8 shadow-lift">
        {/* Header */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <span className="w-6 h-6 rounded-full bg-burgundy text-parchment font-display italic text-sm flex items-center justify-center font-bold">
              p
            </span>
            <span className="font-ui text-xs font-semibold uppercase tracking-wider text-taupe">
              Pocketful Social Split
            </span>
          </div>
          <Badge type="paypal">PayPal Sandbox</Badge>
        </div>

        {paidSuccess ? (
          /* Paid State */
          <div className="text-center py-4">
            <div className="w-14 h-14 bg-moss/20 text-moss rounded-full flex items-center justify-center mx-auto mb-3 text-3xl font-bold">
              ✓
            </div>
            <span className="text-xs font-ui uppercase font-semibold text-moss tracking-wider block">
              Payment Completed
            </span>
            <h2 className="font-display text-2xl font-semibold text-ink my-1">
              You're all set, {data.friendName}!
            </h2>
            <p className="text-xs text-taupe font-ui mb-6">
              Your share of <span className="font-num font-semibold text-ink">{data.shareFormatted}</span> for{' '}
              <span className="font-medium text-ink">{data.venueName}</span> has cleared via PayPal Sandbox.
            </p>

            <div className="bg-sand border border-oat p-3 rounded-[2px] text-xs text-taupe mb-6 font-num">
              Capture Reference: CAP-{token.slice(0, 8).toUpperCase()} · Status: Confirmed
            </div>

            {onBackToApp && (
              <button
                type="button"
                onClick={onBackToApp}
                className="w-full py-2 border border-oat text-xs font-ui text-taupe rounded-[2px] hover:bg-sand"
              >
                Return to Organizer Ledger
              </button>
            )}
          </div>
        ) : data.status === 'refunded' || data.status === 'cancelled' || data.groupStatus === 'cancelled' || data.groupStatus === 'refunded' ? (
          /* Cancelled / Refunded State */
          <div className="text-center py-4">
            <div className="w-14 h-14 bg-brick/10 text-brick rounded-full flex items-center justify-center mx-auto mb-3 text-2xl font-bold">
              ✕
            </div>
            <span className="text-xs font-ui uppercase font-semibold text-brick tracking-wider block">
              Outing Cancelled
            </span>
            <h2 className="font-display text-2xl font-semibold text-ink my-1">
              No Payment Required
            </h2>
            <p className="text-xs text-taupe font-ui mb-6">
              This outing at <span className="font-medium text-ink">{data.venueName}</span> was cancelled by the organizer.
              {data.status === 'refunded' ? ' Any previous payment has been refunded to your PayPal account.' : ' Your payment link is no longer active.'}
            </p>

            {onBackToApp && (
              <button
                type="button"
                onClick={onBackToApp}
                className="w-full py-2 border border-oat text-xs font-ui text-taupe rounded-[2px] hover:bg-sand"
              >
                Return to Ledger
              </button>
            )}
          </div>
        ) : (
          /* Unpaid Invitation State */
          <div>
            <h2 className="font-display text-2xl font-semibold text-ink mb-1">
              {data.organizerName} invited you to {data.venueName}
            </h2>
            <p className="text-xs text-taupe font-ui mb-6">
              This weekend outing has been calculated with zero group friction.
            </p>

            <div className="bg-sand border border-oat p-4 rounded-[2px] mb-6">
              <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-1">
                Your Share
              </span>
              <span className="font-num text-3xl font-semibold text-ink block">
                {data.shareFormatted}
              </span>
              <span className="text-[11px] text-taupe block mt-1">
                Payment deadline: {new Date(data.deadline).toLocaleDateString()}
              </span>
            </div>

            {data.paidFriends.length > 0 && (
              <p className="text-xs text-taupe font-ui mb-6">
                Already paid: <span className="font-medium text-ink">{data.paidFriends.join(', ')}</span>
              </p>
            )}

            <LedgerRule className="my-6" />

            <button
              type="button"
              disabled={paying}
              onClick={handlePay}
              className={`w-full py-3 bg-burgundy text-parchment font-ui text-sm font-semibold rounded-[2px] transition-colors flex items-center justify-center gap-2 shadow-lift border border-maroon ${
                paying ? 'opacity-60 cursor-not-allowed' : 'hover:bg-claret'
              }`}
            >
              {paying ? (
                <span>Capturing PayPal payment...</span>
              ) : (
                <>
                  <span>Pay {data.shareFormatted} with</span>
                  <span className="font-bold italic">PayPal</span>
                </>
              )}
            </button>

            {onBackToApp && (
              <button
                type="button"
                onClick={onBackToApp}
                className="w-full mt-3 text-center text-xs text-taupe underline hover:text-ink"
              >
                Return to Organizer Ledger
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
