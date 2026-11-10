import { logError } from '../lib/log';
import { notifyError } from '../lib/errors';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { LedgerGrid } from '../components/LedgerGrid';
import { Badge } from '../components/Badge';
import { copyToClipboard } from '../lib/clipboard';
import { toast } from '../lib/toast';
import type { ColDef } from 'ag-grid-community';

interface SpendItem {
  id: string;
  occurred_at: string;
  merchant_raw: string;
  category: string;
  amount_minor: number;
  amountFormatted: string;
  match_type: string;
  confidence: number;
  label: string;
  user_rating?: string | null;
  [key: string]: unknown;
}

interface OutingGroup {
  id: string;
  totalMinor: number;
  totalFormatted: string;
  currency: string;
  deadline: string;
  status: string;
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
  }>;
}

export const SpendScreen: React.FC = () => {
  const [timeline, setTimeline] = useState<SpendItem[]>([]);
  const [activeGroups, setActiveGroups] = useState<OutingGroup[]>([]);
  const [selectedSpend, setSelectedSpend] = useState<SpendItem | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [manualPlace, setManualPlace] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [manualCategory, setManualCategory] = useState('cafes');
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const loadData = async () => {
    try {
      const [timelineRes, groupsRes] = await Promise.all([
        apiFetch<{ timeline: SpendItem[] }>('/api/tracker/timeline'),
        apiFetch<{ groups: OutingGroup[] }>('/api/groups').catch(() => ({ groups: [] }))
      ]);
      setTimeline(timelineRes.timeline);
      setActiveGroups(groupsRes.groups || []);
    } catch (err) {
      logError('Failed to load spend tracker data:', err);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRating = async (rating: 'worth_it' | 'okay' | 'too_much') => {
    if (!selectedSpend) return;
    try {
      await apiFetch(`/api/tracker/${selectedSpend.id}/rating`, {
        method: 'POST',
        body: JSON.stringify({ rating })
      });
      setSelectedSpend(null);
      await loadData();
      toast.success('Rating recorded');
    } catch (err: unknown) {
      notifyError(err, 'Rating failed');
    }
  };

  const handleAddManual = async () => {
    if (!manualPlace || !manualAmount) return;
    try {
      await apiFetch('/api/tracker/manual', {
        method: 'POST',
        body: JSON.stringify({
          merchantName: manualPlace,
          amountMinor: Math.round(parseFloat(manualAmount) * 100),
          category: manualCategory
        })
      });
      setShowAddModal(false);
      setManualPlace('');
      setManualAmount('');
      await loadData();
      toast.success('Leisure visit added');
    } catch (err: unknown) {
      notifyError(err, 'Manual entry error');
    }
  };

  const copyFriendLink = async (token: string) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173';
    const link = `${origin}/pay/${token}`;
    await copyToClipboard(link);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2500);
  };

  const spendColumns: ColDef<SpendItem>[] = [
    {
      headerName: 'Date',
      field: 'occurred_at',
      width: 100,
      sort: 'desc',
      cellRenderer: (params: { value: string }) => {
        const d = new Date(params.value);
        return (
          <span className="font-num text-xs text-taupe">
            {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        );
      }
    },
    {
      headerName: 'Place & Merchant',
      field: 'merchant_raw',
      flex: 1.5,
      cellRenderer: (params: { value: string }) => (
        <span className="font-ui font-medium text-ink">{params.value}</span>
      )
    },
    {
      headerName: 'Category',
      field: 'category',
      width: 120,
      cellRenderer: (params: { value: string }) => (
        <span className="text-xs uppercase tracking-wider text-taupe font-ui font-semibold">
          {params.value}
        </span>
      )
    },
    {
      headerName: 'Amount',
      field: 'amountFormatted',
      width: 100,
      cellClass: 'text-right font-num font-semibold text-ink'
    },
    {
      headerName: 'Provenance',
      field: 'label',
      width: 155,
      cellStyle: { display: 'flex', alignItems: 'center' },
      cellRenderer: (params: { value: string }) => {
        const type =
          params.value === 'Followed Pip' ? 'moss'
          : params.value === 'Organic' ? 'paypal'
          : 'seeded';
        return (
          <span style={{ whiteSpace: 'nowrap' }}>
            <Badge type={type}>{params.value}</Badge>
          </span>
        );
      }
    },
    {
      headerName: 'Match',
      field: 'confidence',
      width: 80,
      cellRenderer: (params: { value: number }) => {
        const pct = Math.round((params.value ?? 0) * 100);
        const color = pct >= 85 ? 'text-moss' : pct >= 70 ? 'text-ochre' : 'text-taupe';
        return (
          <span className={`font-num text-xs font-semibold ${color}`}>{pct}%</span>
        );
      }
    },
    {
      headerName: 'Reflection',
      width: 130,
      cellRenderer: (params: { data: SpendItem }) => {
        if (params.data?.user_rating) {
          const ratingColor =
            params.data.user_rating === 'worth_it' ? 'text-moss'
            : params.data.user_rating === 'too_much' ? 'text-brick'
            : 'text-ochre';
          return (
            <span className={`text-xs capitalize font-medium ${ratingColor}`}>
              ✓ {params.data.user_rating.replace('_', ' ')}
            </span>
          );
        }
        return (
          <button
            type="button"
            onClick={() => setSelectedSpend(params.data)}
            className="text-xs text-burgundy underline hover:text-claret font-ui font-medium"
          >
            Worth it?
          </button>
        );
      }
    }
  ];

  const totalSpentMinor = timeline.reduce((acc, curr) => acc + curr.amount_minor, 0);
  const leisureCount = timeline.length;
  const avgMinor = leisureCount > 0 ? Math.round(totalSpentMinor / leisureCount) : 0;

  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-1">
            Spend Tracker & Rhythm
          </span>
          <h1 className="font-display text-2xl font-semibold text-ink">What You Actually Do</h1>
        </div>

        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="px-4 py-1.5 bg-sand border border-oat text-xs font-ui text-ink rounded-[2px] hover:bg-parchment shadow-lift font-medium"
        >
          + Add a Visit
        </button>
      </div>

      {/* Top Ledger Strip */}
      <div className="bg-parchment border border-oat p-4 rounded-surface mb-6 grid grid-cols-3 gap-4 shadow-lift">
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-0.5">
            Leisure This Month
          </span>
          <span className="font-num text-2xl font-semibold text-ink">
            ${(totalSpentMinor / 100).toFixed(2)}
          </span>
        </div>
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-0.5">
            Outings Tracked
          </span>
          <span className="font-num text-2xl font-semibold text-ink">{leisureCount}</span>
        </div>
        <div className="text-right">
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-0.5">
            Avg per Outing
          </span>
          <span className="font-num text-2xl font-semibold text-ink">
            ${(avgMinor / 100).toFixed(2)}
          </span>
        </div>
      </div>

      {/* Spend AG Grid */}
      <div className="mb-8">
        <LedgerGrid<SpendItem>
          rowData={timeline}
          columnDefs={spendColumns}
          height={420}
          emptyMessage="No leisure expenses recorded yet. Sync with PayPal or tap 'Add a Visit'."
        />
      </div>

      {/* Active Group Splits & Requests Section */}
      {activeGroups.length > 0 && (
        <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift mb-8">
          <div className="flex justify-between items-center mb-4">
            <div>
              <span className="text-xs font-ui uppercase tracking-wider text-taupe font-semibold">
                Social Splits & Outing Requests
              </span>
              <h2 className="font-display text-lg font-semibold text-ink">
                Tracking Received Friend Payments
              </h2>
            </div>
            <Badge type="paypal">PayPal Sandbox</Badge>
          </div>

          <div className="space-y-4">
            {activeGroups.map((g) => (
              <div key={g.id} className="p-4 bg-sand border border-oat rounded-[2px]">
                <div className="flex justify-between items-center mb-2">
                  <div>
                    <span className="text-xs font-semibold text-ink block">
                      Outing Bill · {g.totalFormatted}
                    </span>
                    <span className="text-[11px] text-taupe">
                      Deadline: {new Date(g.deadline).toLocaleDateString()}
                    </span>
                  </div>
                  <Badge type={g.isConfirmed ? 'moss' : 'ochre'}>
                    {g.paidCount} of {g.totalFriends} Paid
                  </Badge>
                </div>

                <div className="divide-y divide-oat border-t border-oat my-2">
                  {g.payments.map((p) => (
                    <div key={p.id} className="py-2 flex justify-between items-center text-xs font-ui">
                      <div>
                        <span className="font-medium text-ink block">{p.friendName}</span>
                        <span className="text-[10px] text-taupe">{p.contact}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-num font-semibold text-ink">{p.shareFormatted}</span>
                        <Badge type={p.status === 'paid' ? 'moss' : 'ochre'}>
                          {p.status.toUpperCase()}
                        </Badge>
                        <button
                          type="button"
                          onClick={() => copyFriendLink(p.publicToken)}
                          className="px-2 py-0.5 border border-oat rounded-[2px] bg-parchment hover:bg-linen text-[11px] font-ui"
                        >
                          {copiedToken === p.publicToken ? '✓ Copied' : 'Copy Pay Link'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* E3: "Worth it?" Modal */}
      {selectedSpend && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedSpend(null)}
        >
          <div
            className="bg-parchment border border-oat w-full max-w-md rounded-surface p-6 shadow-lift text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-semibold text-ink mb-1">
              Was {selectedSpend.merchant_raw} worth it?
            </h3>
            <p className="text-xs text-taupe mb-6 font-ui">
              Spent {selectedSpend.amountFormatted}. Stamping reflection helps Pip calibrate your
              price tolerance.
            </p>

            <div className="grid grid-cols-3 gap-3 mb-6">
              {(
                [
                  { id: 'worth_it', label: 'Worth It', weight: '+1.5' },
                  { id: 'okay', label: 'Okay', weight: '+1.0' },
                  { id: 'too_much', label: 'Too Much', weight: 'penalty' }
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleRating(opt.id)}
                  className="p-3 bg-sand border border-oat rounded-[2px] hover:bg-blush hover:border-burgundy transition-colors text-center"
                >
                  <span className="block text-xs font-semibold text-ink font-ui">{opt.label}</span>
                  <span className="block text-[10px] text-taupe mt-1 font-num">{opt.weight}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setSelectedSpend(null)}
              className="text-xs text-taupe underline hover:text-ink font-ui"
            >
              Ask me later
            </button>
          </div>
        </div>
      )}

      {/* Add Manual Visit Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          onClick={() => setShowAddModal(false)}
        >
          <div
            className="bg-parchment border border-oat w-full max-w-md rounded-surface p-6 shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-semibold text-ink mb-4">Add a Leisure Visit</h3>

            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Place Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Quiet Leaf Cafe"
                  value={manualPlace}
                  onChange={(e) => setManualPlace(e.target.value)}
                  className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Amount Spent ($)
                </label>
                <input
                  type="number"
                  placeholder="24.50"
                  value={manualAmount}
                  onChange={(e) => setManualAmount(e.target.value)}
                  className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs font-num text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Category
                </label>
                <select
                  value={manualCategory}
                  onChange={(e) => setManualCategory(e.target.value)}
                  className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                >
                  <option value="cafes">Cafes & Coffee</option>
                  <option value="gaming">Board Games & Arcades</option>
                  <option value="sports">Climbing & Sports</option>
                  <option value="workshops">Workshops & Craft</option>
                  <option value="arts">Cinema & Arts</option>
                  <option value="outdoors">Outdoors & Trails</option>
                </select>
              </div>
            </div>

            <div className="flex justify-between items-center pt-3 border-t border-oat">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="text-xs text-taupe underline"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddManual}
                className="px-5 py-2 bg-burgundy text-parchment text-xs font-medium rounded-[2px] hover:bg-claret"
              >
                Save to Ledger
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
