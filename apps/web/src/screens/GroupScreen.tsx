import { logError } from '../lib/log';
import React, { useState, useEffect } from 'react';
import { apiFetch, sealApproval, previewGroupSplit, type GroupSplitPreview } from '../lib/api';
import { ApprovalSeal } from '../components/ApprovalSeal';
import { copyToClipboard } from '../lib/clipboard';
import { Badge } from '../components/Badge';
import { LedgerRule } from '../components/LedgerRule';
import { toast } from '../lib/toast';
import { notifyError, describeApiError } from '../lib/errors';
import { formatMoney } from '../lib/money';

interface GroupScreenProps {
  initialSuggestionId?: string;
  initialVenueName?: string;
  initialTotal?: string;
  initialGroupSize?: number;
  onBackToPlan: () => void;
}

interface FriendRow {
  name: string;
  contact: string;
  shareMinor: number;
}

interface GroupData {
  group: {
    id: string;
    total_minor: number;
    currency: string;
    deadline: string;
    status: 'draft' | 'pending' | 'confirmed' | 'refunding' | 'refunded' | 'cancelled';
  };
  totalFormatted: string;
  paidCount: number;
  totalFriends: number;
  isConfirmed: boolean;
  payments: Array<{
    id: string;
    friendName: string;
    contact: string;
    shareMinor: number;
    shareFormatted: string;
    status: string;
    publicToken: string;
    payUrl: string | null;
    paidAt: string | null;
  }>;
}

// Demo companion data for pre-filling the group split builder
const DEMO_FRIENDS = [
  { name: 'Maya Lin', contact: 'maya.lin@example.com' },
  { name: 'Rohan Patel', contact: 'rohan.patel@example.com' }
];

export const GroupScreen: React.FC<GroupScreenProps> = ({
  initialSuggestionId,
  initialVenueName = 'Quiet Leaf Cafe',
  initialTotal = '$100.00',
  initialGroupSize = 3,
  onBackToPlan
}) => {
  const parsedTotal = initialTotal
    ? Math.round((parseFloat(initialTotal.replace(/[^0-9.]/g, '')) || 100) * 100)
    : 10000;
  const totalAmount = parsedTotal > 0 ? parsedTotal : 10000;

  // Initialize friends list based on group size (groupSize minus organizer)
  const defaultFriendCount = Math.max(1, (initialGroupSize || 3) - 1);
  const [friends, setFriends] = useState<FriendRow[]>(() => {
    const initialParticipants = defaultFriendCount + 1;
    const equalShare = Math.floor(totalAmount / initialParticipants); // only a starting value for custom mode
    return Array.from({ length: defaultFriendCount }).map((_, i) => ({
      name: DEMO_FRIENDS[i]?.name ?? '',
      contact: DEMO_FRIENDS[i]?.contact ?? '',
      shareMinor: equalShare
    }));
  });
  const [splitMode, setSplitMode] = useState<'equal' | 'custom'>('equal');
  // Equal-split amounts come from the server (the same function that stages the group). null = loading or failed.
  const [serverSplit, setServerSplit] = useState<GroupSplitPreview | null>(null);
  const [splitError, setSplitError] = useState<string | null>(null);

  // Staged group approval
  const [groupId, setGroupId] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [approvalPreview, setApprovalPreview] = useState<string | null>(null);
  const [executingSeal, setExecutingSeal] = useState(false);

  // Active live group state
  const [groupData, setGroupData] = useState<GroupData | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);

  // Poll live group status when active (only after approval is sealed)
  useEffect(() => {
    if (!groupId || approvalPreview) return;

    const interval = setInterval(async () => {
      try {
        const data = await apiFetch<GroupData>(`/api/groups/${groupId}`);
        setGroupData(data);
      } catch (err) {
        logError('Group poll error:', err);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [groupId, approvalPreview]);

  const handleCancelOuting = () => {
    if (!groupId || cancelling) return;
    setShowCancelModal(true);
  };

  const confirmCancelOuting = async () => {
    setShowCancelModal(false);
    if (!groupId || cancelling) return;
    setCancelling(true);
    try {
      const res = await apiFetch<{
        approvalId?: string;
        preview?: string;
        status: string;
        paidCount?: number;
        message?: string;
      }>(`/api/groups/${groupId}/cancel`, { method: 'POST' });

      if (res.approvalId && res.preview) {
        setGroupData(null);
        setApprovalId(res.approvalId);
        setApprovalPreview(res.preview);
      } else {
        const updated = await apiFetch<GroupData>(`/api/groups/${groupId}`);
        setGroupData(updated);
      }
    } catch (err: unknown) {
      notifyError(err, 'Cancel outing error');
    } finally {
      setCancelling(false);
    }
  };

  const handleAddFriend = () => {
    setFriends([...friends, { name: '', contact: '', shareMinor: 0 }]);
  };

  const handleRemoveFriend = (index: number) => {
    setFriends(friends.filter((_, i) => i !== index));
  };

  const handleFriendChange = (index: number, field: 'name' | 'contact', value: string) => {
    const updated = [...friends];
    const target = updated[index];
    if (!target) return;
    updated[index] = { ...target, [field]: value };
    setFriends(updated);
  };

  const handleFriendShareChange = (index: number, dollarVal: string) => {
    const parsed = parseFloat(dollarVal) || 0;
    const shareMinor = Math.round(parsed * 100);
    const updated = [...friends];
    const target = updated[index];
    if (!target) return;
    updated[index] = { ...target, shareMinor };
    setFriends(updated);
  };

  const totalParticipants = friends.length + 1; // Friends + organizer

  useEffect(() => {
    if (splitMode !== 'equal' || totalAmount <= 0 || friends.length < 1) return;
    const controller = new AbortController();
    setServerSplit(null);
    setSplitError(null);
    const timer = setTimeout(() => {
      previewGroupSplit(totalAmount, friends.length, controller.signal)
        .then((p) => {
          if (!controller.signal.aborted) setServerSplit(p);
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) setSplitError(describeApiError(err).message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort(); // a newer input supersedes this request; its late response must not overwrite the screen
    };
  }, [splitMode, totalAmount, friends.length]);

  const equalReady = splitMode === 'custom' || serverSplit !== null;
  const friendsTotalMinor =
    splitMode === 'equal'
      ? (serverSplit?.friendShares ?? []).reduce((sum, s) => sum + s, 0)
      : friends.reduce((sum, f) => sum + f.shareMinor, 0);
  const organizerShareMinor =
    splitMode === 'equal' ? (serverSplit?.organizerShareMinor ?? 0) : totalAmount - friendsTotalMinor;
  const isCustomOverflow = splitMode === 'custom' && organizerShareMinor < 0;
  const isValidFriends =
    friends.length > 0 &&
    friends.every(
      (f) =>
        f.name.trim().length > 0 &&
        f.contact.trim().length > 0 &&
        (splitMode === 'equal' || f.shareMinor > 0)
    );

  const handleStageGroup = async () => {
    if (!isValidFriends || isCustomOverflow || !equalReady || loading) return;
    setLoading(true);
    try {
      const res = await apiFetch<{
        groupId: string;
        approvalId: string;
        preview: string;
      }>('/api/groups', {
        method: 'POST',
        body: JSON.stringify({
          suggestionId: initialSuggestionId,
          totalMinor: totalAmount,
          splitMode,
          friends: friends.map((f) => ({
            name: f.name.trim(),
            contact: f.contact.trim(),
            shareMinor: splitMode === 'custom' ? f.shareMinor : undefined
          }))
        })
      });

      setGroupId(res.groupId);
      setApprovalId(res.approvalId);
      setApprovalPreview(res.preview);
    } catch (err: unknown) {
      notifyError(err, 'Group split staging error');
    } finally {
      setLoading(false);
    }
  };

  const handleSealApproval = async () => {
    if (!approvalId || !groupId || executingSeal) return;
    setExecutingSeal(true);
    try {
      const sealed = await sealApproval(approvalId, `group_seal_${approvalId}`);

      setApprovalPreview(null);
      // Fetch initial live status
      const data = await apiFetch<GroupData>(`/api/groups/${groupId}`);
      setGroupData(data);
      toast.success(sealed.reconciling ? 'Group split requests sent. Finalizing in the background.' : 'Group split requests sent');
    } catch (err: unknown) {
      notifyError(err, 'Approval did not complete');
      throw err;
    } finally {
      setExecutingSeal(false);
    }
  };

  const copyFriendLink = async (token: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
    const link = `${origin}/pay/${token}`;
    await copyToClipboard(link);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2500);
  };

  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12">
      <button
        type="button"
        onClick={onBackToPlan}
        className="text-xs font-ui text-taupe underline hover:text-ink mb-4 block"
      >
        ← Back to Plan Tickets
      </button>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-2">
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe">
            Social Split Engine
          </span>
          <h1 className="font-display text-2xl font-semibold text-ink">
            {initialVenueName} Outing Split
          </h1>
        </div>
        <div className="text-right">
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block">Bill Total</span>
          <span className="font-num text-2xl font-semibold text-ink">{initialTotal}</span>
        </div>
      </div>

      {/* D2: Guardian Approval & Seal Sheet */}
      {approvalPreview ? (
        <div className="bg-parchment border border-burgundy p-6 sm:p-8 rounded-surface shadow-lift">
          <h3 className="font-display text-lg font-semibold text-burgundy mb-2">
            Review Requests & Hold to Seal
          </h3>
          <p className="text-sm font-ui text-ink leading-relaxed mb-6">{approvalPreview}</p>

          <div className="flex justify-center py-4 border-t border-oat">
            <ApprovalSeal
              onApprove={handleSealApproval}
              disabled={executingSeal}
              label={executingSeal ? 'Sending PayPal requests...' : 'Hold to seal & send requests'}
            />
          </div>

          <div className="mt-3 text-center">
            <button
              type="button"
              disabled={executingSeal}
              onClick={() => {
                setApprovalPreview(null);
                setApprovalId(null);
              }}
              className="text-xs text-taupe underline hover:text-ink font-ui"
            >
              Cancel & Edit Split
            </button>
          </div>
        </div>
      ) : groupData ? (
        /* D3: Active Live Group Status (Internal Organizer Dashboard - Strictly Read-Only) */
        <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift mb-8">
          <div className="flex justify-between items-center mb-4">
            <div>
              <span className="text-xs font-ui uppercase font-semibold text-taupe tracking-wider">
                Group Outing Status · Read-Only Organizer View
              </span>
              <h2 className="font-display text-xl font-semibold text-ink">
                {groupData.group.status === 'refunded'
                  ? 'Outing Cancelled & Refunded'
                  : groupData.group.status === 'cancelled'
                  ? 'Outing Cancelled'
                  : groupData.isConfirmed
                  ? 'All Shares Paid — Outing Confirmed!'
                  : 'Waiting for Friend Payments'}
              </h2>
            </div>
            {groupData.group.status === 'refunded' ? (
              <Badge type="brick">Cancelled & Refunded</Badge>
            ) : groupData.group.status === 'cancelled' ? (
              <Badge type="brick">Cancelled</Badge>
            ) : groupData.isConfirmed ? (
              <Badge type="moss">Booking Confirmed</Badge>
            ) : (
              <Badge type="ochre">
                {groupData.paidCount} of {groupData.totalFriends} Paid
              </Badge>
            )}
          </div>

          <p className="text-xs text-taupe font-ui mb-4">
            Payment deadline:{' '}
            <span className="font-num font-semibold text-ink">
              {new Date(groupData.group.deadline).toLocaleString()}
            </span>
            . Friends must pay directly via their unique PayPal links. Organizer cannot pay on their behalf.
          </p>

          <div className="divide-y divide-oat border-t border-b border-oat my-4">
            {groupData.payments.map((p) => (
              <div key={p.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm font-ui">
                <div>
                  <span className="font-medium text-ink block">{p.friendName}</span>
                  <span className="text-xs text-taupe">{p.contact}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-num font-semibold text-ink">{p.shareFormatted}</span>
                  <Badge
                    type={
                      p.status === 'paid'
                        ? 'moss'
                        : p.status === 'refunded' || p.status === 'cancelled'
                        ? 'brick'
                        : 'ochre'
                    }
                  >
                    {p.status.toUpperCase()}
                  </Badge>

                  {/* Public Link Copy Button (Organizer shares with friend; never pays on behalf) */}
                  {groupData.group.status !== 'cancelled' && groupData.group.status !== 'refunded' && (
                    <button
                      type="button"
                      onClick={() => copyFriendLink(p.publicToken)}
                      className="px-2.5 py-1 bg-sand border border-oat text-xs font-ui text-ink rounded-[2px] hover:bg-linen transition-colors font-medium"
                    >
                      {copiedToken === p.publicToken ? '✓ Copied Link' : 'Copy Pay Link'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {copiedToken && (
            <div className="p-2.5 bg-blush border border-burgundy rounded-[2px] text-xs text-burgundy font-ui text-center">
              ✓ Public checkout link copied to clipboard! Send this URL to your friend so they can pay via PayPal.
            </div>
          )}

          {groupData.isConfirmed && (
            <div className="mt-4 p-3 bg-blush border border-burgundy rounded-[2px] text-xs text-burgundy font-ui text-center">
              ✓ All participants paid. The simulated venue booking seal has locked in. Enjoy your
              weekend!
            </div>
          )}

          {(groupData.group.status === 'cancelled' || groupData.group.status === 'refunded') && (
            <div className="mt-4 p-3 bg-blush border border-burgundy rounded-[2px] text-xs text-burgundy font-ui text-center">
              This outing was cancelled. {groupData.group.status === 'refunded' ? 'Paid friend shares were refunded via PayPal Sandbox.' : 'No payments were taken.'}
            </div>
          )}

          {groupData.group.status !== 'cancelled' && groupData.group.status !== 'refunded' && (
            <div className="mt-4 pt-4 border-t border-oat flex justify-between items-center">
              <span className="text-xs text-taupe font-ui">
                Need to change or cancel this outing?
              </span>
              <button
                type="button"
                disabled={cancelling}
                onClick={handleCancelOuting}
                className="px-3 py-1.5 border border-brick/40 text-brick hover:bg-blush hover:border-brick text-xs font-ui rounded-[2px] transition-colors"
              >
                {cancelling ? 'Cancelling...' : 'Cancel Outing'}
              </button>
            </div>
          )}
        </div>
      ) : (
        /* D1: Group Builder */
        <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-display text-lg font-semibold text-ink">Add Outing Friends</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSplitMode('equal')}
                className={`px-3 py-1 text-xs border rounded-[2px] font-ui transition-colors ${
                  splitMode === 'equal'
                    ? 'bg-burgundy text-parchment border-burgundy font-medium'
                    : 'bg-sand border-oat text-ink hover:bg-linen'
                }`}
              >
                Equal Split
              </button>
              <button
                type="button"
                onClick={() => setSplitMode('custom')}
                className={`px-3 py-1 text-xs border rounded-[2px] font-ui transition-colors ${
                  splitMode === 'custom'
                    ? 'bg-burgundy text-parchment border-burgundy font-medium'
                    : 'bg-sand border-oat text-ink hover:bg-linen'
                }`}
              >
                Custom Split
              </button>
            </div>
          </div>

          {/* Mode explanation */}
          <p className="text-xs text-taupe font-ui mb-4">
            {splitMode === 'equal'
              ? splitError
                ? `Could not load the split: ${splitError}`
                : `Split evenly across ${totalParticipants} people. Amounts below are exact; any odd cents are rotated between people.`
              : 'Enter custom dollar amounts for each friend. Organizer covers the remaining balance.'}
          </p>

          <div className="space-y-3 mb-6">
            {friends.map((friend, idx) => {
              const friendShare = serverSplit?.friendShares[idx];
              return (
                <div key={idx} className="flex flex-col sm:flex-row gap-2 sm:items-center">
                  <input
                    type="text"
                    placeholder="Friend Name"
                    value={friend.name}
                    onChange={(e) => handleFriendChange(idx, 'name', e.target.value)}
                    className="flex-1 bg-sand border border-oat rounded-[2px] px-3 py-1.5 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                  />
                  <input
                    type="email"
                    placeholder="Email or Phone"
                    value={friend.contact}
                    onChange={(e) => handleFriendChange(idx, 'contact', e.target.value)}
                    className="flex-1 bg-sand border border-oat rounded-[2px] px-3 py-1.5 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                  />

                  {splitMode === 'equal' ? (
                    <span className="font-num text-xs text-taupe font-semibold w-24 text-right pr-2">
                      {friendShare === undefined ? "…" : formatMoney(friendShare)}
                    </span>
                  ) : (
                  <div className="flex items-center gap-1 w-28">
                    <span className="font-num text-xs text-taupe">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="1"
                      placeholder="Amount"
                      value={friend.shareMinor > 0 ? (friend.shareMinor / 100).toString() : ''}
                      onChange={(e) => handleFriendShareChange(idx, e.target.value)}
                      className="w-full bg-sand border border-oat rounded-[2px] px-2 py-1.5 text-xs font-num text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    />
                  </div>
                )}

                {friends.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveFriend(idx)}
                    className="text-xs text-brick hover:underline px-1"
                    title="Remove friend"
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}
        </div>

          {/* Custom Remainder & Validation Summary */}
          {splitMode === 'custom' && (
            <div
              className={`p-3 rounded-[2px] border text-xs font-ui mb-4 ${
                isCustomOverflow
                  ? 'bg-blush border-burgundy text-burgundy'
                  : 'bg-sand border-oat text-ink'
              }`}
            >
              <div className="flex justify-between items-center mb-1">
                <span>Friends Total Share:</span>
                <span className="font-num font-semibold">
                  {equalReady ? formatMoney(friendsTotalMinor) : '…'}
                </span>
              </div>
              <div className="flex justify-between items-center font-medium">
                <span>Organizer Share (You):</span>
                <span className={`font-num ${isCustomOverflow ? 'text-burgundy' : 'text-ink'}`}>
                  {equalReady ? formatMoney(organizerShareMinor) : '…'}
                </span>
              </div>
              {isCustomOverflow && (
                <p className="text-[11px] text-burgundy mt-1">
                  Friend shares exceed the bill total ({formatMoney(totalAmount)}). Please lower their amounts.
                </p>
              )}
            </div>
          )}

          <LedgerRule className="my-4" />

          <div className="flex justify-between items-center">
            <button
              type="button"
              onClick={handleAddFriend}
              className="text-xs font-ui text-burgundy underline hover:text-claret font-medium"
            >
              + Add another friend
            </button>
            <button
              type="button"
              disabled={loading || !isValidFriends || isCustomOverflow || !equalReady}
              onClick={handleStageGroup}
              className={`px-6 py-2 bg-burgundy text-parchment font-ui text-sm font-medium rounded-[2px] transition-colors shadow-lift ${
                loading || !isValidFriends || isCustomOverflow || !equalReady
                  ? 'opacity-50 cursor-not-allowed'
                  : 'hover:bg-claret active:bg-maroon'
              }`}
            >
              {loading ? 'Calculating...' : 'Review Requests →'}
            </button>
          </div>
        </div>
      )}

      {showCancelModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
        >
          <div className="bg-parchment border border-burgundy p-6 rounded-surface shadow-lift max-w-md w-full">
            <h3 id="cancel-modal-title" className="font-display text-lg font-semibold text-burgundy mb-2">
              Cancel Group Outing
            </h3>
            <p className="text-sm font-ui text-ink mb-6">
              Are you sure you want to cancel this group outing? Any paid friend shares will be refunded.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowCancelModal(false)}
                className="px-3 py-1.5 border border-oat text-ink hover:bg-sand text-xs font-ui rounded-[2px]"
              >
                Keep Outing
              </button>
              <button
                type="button"
                onClick={confirmCancelOuting}
                className="px-3 py-1.5 bg-brick text-parchment hover:bg-brick/90 text-xs font-ui rounded-[2px] font-medium"
              >
                Yes, Cancel Outing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
