import { logError } from '../lib/log';
import React, { useState, useEffect } from 'react';
import { apiFetch, sealApproval } from '../lib/api';
import { notifyError } from '../lib/errors';
import { LedgerRule } from '../components/LedgerRule';
import { Badge } from '../components/Badge';
import { LedgerGrid } from '../components/LedgerGrid';
import { ApprovalSeal } from '../components/ApprovalSeal';
import { RuledPlaceholder } from '../components/RuledPlaceholder';
import { SundayVaultModal } from '../components/SundayVaultModal';
import { getStoredUser } from '../lib/supabase';
import { formatMoney } from '../lib/money';
import type { ColDef } from 'ag-grid-community';

interface LedgerScreenProps {
  onPlanClick: () => void;
  onOpenChat: () => void;
}

interface WalletData {
  statement: {
    totalBalanceMinor: number;
    totalBalanceFormatted: string;
    totalBalanceSource: string;
    fixedBillsMinor: number;
    fixedBillsFormatted: string;
    fixedBillsSource: string;
    subscriptionsMinor: number;
    subscriptionsFormatted: string;
    subscriptionsSource: string;
    savingsGoalMinor: number;
    savingsGoalFormatted: string;
    savingsGoalSource: string;
    freeForWeekendMinor: number;
    freeForWeekendFormatted: string;
    guiltFreeCapMinor: number;
    currency: string;
  };
  pockets: {
    weekly: number;
    holiday: number;
    getaway: number;
  };
  vault?: {
    goalBalanceMinor: number;
    goalBalanceFormatted: string;
    rolloverBalanceMinor: number;
    rolloverBalanceFormatted: string;
    isSimulated: boolean;
  };
}

interface GhostSubscription {
  id: string;
  merchant: string;
  amount_minor: number;
  interval: string;
  flagged_ghost: boolean;
  explanation: string;
  [key: string]: unknown;
}

interface AuditData {
  totalMonthlyWasteMinor: number;
  totalYearlyWasteMinor: number;
  totalYearlyWasteFormatted: string;
  ghostSubscriptions: GhostSubscription[];
}

export const LedgerScreen: React.FC<LedgerScreenProps> = ({ onPlanClick, onOpenChat }) => {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);

  // Sheets state
  const [showAuditSheet, setShowAuditSheet] = useState(false);
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([]);
  const [cancelPreview, setCancelPreview] = useState<{
    approvalId: string;
    preview: string;
    yearlySavingMinor: number;
  } | null>(null);
  const [showSuccessSheet, setShowSuccessSheet] = useState(false);
  const [cancelledResult, setCancelledResult] = useState<{
    count: number;
    yearlySaved: string;
  } | null>(null);
  const [executingSeal, setExecutingSeal] = useState(false);
  const [showVaultModal, setShowVaultModal] = useState(false);

  // Mood stamps
  const [selectedMood, setSelectedMood] = useState<'drained' | 'okay' | 'great' | null>(null);

  const loadData = async () => {
    try {
      const [walletRes, auditRes] = await Promise.all([
        apiFetch<WalletData>('/api/wallet'),
        apiFetch<AuditData>('/api/subscriptions/audit')
      ]);
      setWallet(walletRes);
      setAudit(auditRes);
    } catch (err) {
      logError('Failed to load wallet ledger:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleMoodSelect = async (mood: 'drained' | 'okay' | 'great') => {
    setSelectedMood(mood);
    try {
      await apiFetch('/api/mood', {
        method: 'POST',
        body: JSON.stringify({ level: mood })
      });
    } catch (err) {
      logError('Mood save error:', err);
    }
  };

  const handlePrepareCancel = async () => {
    if (selectedSubIds.length === 0) return;
    try {
      const res = await apiFetch<{
        approvalId: string;
        preview: string;
        yearlySavingMinor: number;
      }>('/api/subscriptions/cancel/preview', {
        method: 'POST',
        body: JSON.stringify({ subscriptionIds: selectedSubIds })
      });
      setCancelPreview(res);
    } catch (err: unknown) {
      notifyError(err);
    }
  };

  const handleExecuteSeal = async () => {
    if (!cancelPreview || executingSeal) return;
    setExecutingSeal(true);
    try {
      await sealApproval(cancelPreview.approvalId, `cancel_exec_${cancelPreview.approvalId}`);

      setCancelledResult({
        count: selectedSubIds.length,
        yearlySaved: formatMoney(cancelPreview.yearlySavingMinor, statement?.currency)
      });

      setCancelPreview(null);
      setShowAuditSheet(false);
      setShowSuccessSheet(true);

      // Refresh wallet & audit data
      await loadData();
    } catch (err: unknown) {
      notifyError(err, 'Approval did not complete');
      throw err;
    } finally {
      setExecutingSeal(false);
    }
  };

  // AG Grid columns for Subscription Audit (B2)
  const auditColumns: ColDef<GhostSubscription>[] = [
    {
      headerName: '',
      checkboxSelection: true,
      headerCheckboxSelection: true,
      width: 48,
      maxWidth: 48,
      resizable: false
    },
    {
      headerName: 'Subscription',
      field: 'merchant',
      flex: 1.5,
      cellRenderer: (params: { value: string }) => (
        <span className="font-ui font-medium text-ink">{params.value}</span>
      )
    },
    {
      headerName: 'Monthly',
      field: 'amount_minor',
      width: 110,
      cellClass: 'text-right font-num',
      valueFormatter: (params) => formatMoney(params.value as number, statement?.currency)
    },
    {
      headerName: 'Yearly Waste',
      width: 120,
      cellClass: 'text-right font-num font-semibold text-brick',
      valueGetter: (params) => {
        const m = params.data?.amount_minor ?? 0;
        return formatMoney(m * 12, statement?.currency);
      }
    },
    {
      headerName: 'Pip Flag Reason',
      field: 'explanation',
      flex: 2,
      cellRenderer: (params: { value: string }) => (
        <span className="font-ui text-xs text-taupe truncate block">{params.value}</span>
      )
    }
  ];

  if (loading || !wallet) {
    return <RuledPlaceholder message="Pip is balancing your Friday ledger statement..." rows={4} />;
  }

  const { statement } = wallet;

  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12">
      {/* Header Greeting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-1">
            Friday Ledger
          </span>
          <h1 className="font-display text-2xl sm:text-3xl font-semibold text-charcoal">
            Good evening{getStoredUser()?.name ? `, ${getStoredUser()!.name.split(' ')[0]}` : ''}.
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onOpenChat}
            className="flex items-center gap-2 px-3 py-1.5 border border-oat rounded-[2px] bg-parchment hover:bg-blush-pink hover:border-dusty-rose text-xs font-ui text-charcoal transition-colors shadow-lift"
          >
            <span className="w-2 h-2 rounded-full bg-burgundy" />
            <span>Pip Drawer</span>
          </button>
          <button
            type="button"
            onClick={onPlanClick}
            className="px-5 py-2 bg-burgundy text-parchment font-ui text-sm font-medium rounded-[2px] hover:bg-claret active:bg-maroon transition-colors shadow-lift"
          >
            Plan My Weekend
          </button>
        </div>
      </div>

      {/* Found Money Banner Strip with soft monochromatic blush-pink & dusty-rose */}
      {audit && audit.ghostSubscriptions.length > 0 && (
        <div className="bg-blush-pink border border-dusty-rose/70 p-4 rounded-surface mb-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 shadow-lift">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-burgundy/10 text-burgundy flex items-center justify-center flex-shrink-0 mt-0.5">
              <svg className="w-4 h-4 stroke-burgundy fill-none" viewBox="0 0 24 24" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <p className="font-ui text-sm font-semibold text-burgundy">
                Found {audit.totalYearlyWasteFormatted} a year you weren’t using
              </p>
              <p className="text-xs text-maroon">
                {audit.ghostSubscriptions.length} subscriptions identified with no usage or
                duplicate charges.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowAuditSheet(true)}
            className="px-4 py-1.5 bg-burgundy text-parchment text-xs font-medium rounded-[2px] hover:bg-claret transition-colors whitespace-nowrap"
          >
            Review & Cancel
          </button>
        </div>
      )}

      {/* Main Ledger Statement Card elevated in crisp-white with charcoal typography */}
      <div className="bg-crisp-white border border-oat p-6 sm:p-8 rounded-surface shadow-lift mb-8">
        <div className="flex justify-between items-baseline mb-4">
          <h2 className="font-display text-lg font-semibold text-charcoal">Wallet Statement</h2>
          <span className="text-xs text-taupe font-ui uppercase tracking-wider">
            Reconciled with PayPal Sandbox
          </span>
        </div>

        <div className="divide-y divide-oat text-sm font-ui">
          {/* Total Checking Balance */}
          <div className="py-3 flex justify-between items-center">
            <span className="text-charcoal font-medium">Checking & PayPal Balance</span>
            <div className="flex items-center gap-3">
              <Badge type="paypal">PayPal Sandbox</Badge>
              <span className="font-num text-base text-charcoal">{statement.totalBalanceFormatted}</span>
            </div>
          </div>

          {/* Fixed Bills */}
          <div className="py-3 flex justify-between items-center">
            <span className="text-taupe">Less: Fixed Bills & Rent (Reserved)</span>
            <div className="flex items-center gap-3">
              <Badge type="seeded">Seeded</Badge>
              <span className="font-num text-base text-brick">
                -{statement.fixedBillsFormatted}
              </span>
            </div>
          </div>

          {/* Subscriptions */}
          <div className="py-3 flex justify-between items-center">
            <span className="text-taupe">Less: Active Subscriptions</span>
            <div className="flex items-center gap-3">
              <Badge type="paypal">PayPal</Badge>
              <span className="font-num text-base text-brick">
                -{statement.subscriptionsFormatted}
              </span>
            </div>
          </div>

          {/* Savings Goal */}
          <div className="py-3 flex justify-between items-center">
            <span className="text-taupe">Less: Monthly Savings Reserve</span>
            <div className="flex items-center gap-3">
              <Badge type="seeded">Simulated</Badge>
              <span className="font-num text-base text-brick">
                -{statement.savingsGoalFormatted}
              </span>
            </div>
          </div>
        </div>

        {/* Accountant Double Rule Divider */}
        <LedgerRule double className="my-4" />

        {/* Free for the Weekend Hero Figure in magazine charcoal */}
        <div className="pt-2 flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
          <div>
            <span className="text-xs font-ui uppercase font-semibold tracking-wider text-burgundy block mb-1">
              Free for the weekend
            </span>
            <div className="font-num text-4xl sm:text-5xl font-semibold text-charcoal tracking-tight">
              {statement.freeForWeekendFormatted}
            </div>
            <p className="text-xs text-taupe font-ui mt-1">
              Guilt-free ceiling: {formatMoney(statement.guiltFreeCapMinor, statement.currency)} · Resets every Monday.
            </p>
          </div>

          <button
            type="button"
            onClick={onPlanClick}
            className="px-6 py-2.5 bg-burgundy text-parchment font-ui text-sm font-semibold rounded-[2px] hover:bg-claret active:bg-maroon transition-colors"
          >
            Plan Weekend Outing
          </button>
        </div>
      </div>

      {/* G1: Savings Vault & Weekend Rollover elevated in crisp-white */}
      <div className="bg-crisp-white border border-oat p-6 rounded-surface shadow-lift mb-8">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 gap-2">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-ui uppercase tracking-wider text-taupe font-semibold">
                Savings & Rollover Vault
              </span>
              <Badge type="simulated">Simulated Vault</Badge>
            </div>
            <h3 className="font-display text-lg font-semibold text-charcoal">
              Where Your Leftover Fun Money Grows
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setShowVaultModal(true)}
            className="px-4 py-1.5 bg-sand/60 border border-oat text-xs font-ui text-charcoal rounded-[2px] hover:bg-blush-pink hover:border-dusty-rose transition-colors shadow-lift font-medium"
          >
            Sunday Vault Decision →
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 bg-sand/30 hover:bg-blush-pink/30 border border-oat hover:border-dusty-rose/60 rounded-[2px] transition-colors">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs font-ui uppercase tracking-wider text-taupe font-semibold">
                Emergency Goal Vault
              </span>
              <span className="font-num text-xs text-moss font-semibold">Active</span>
            </div>
            <span className="font-num text-2xl font-semibold text-charcoal block">
              {wallet.vault?.goalBalanceFormatted ?? '$400.00'}
            </span>
            <span className="text-[11px] text-taupe font-ui mt-1 block">
              Dedicated emergency reserve, locked away from impulsive weekend splurges.
            </span>
          </div>

          <div className="p-4 bg-sand/30 hover:bg-blush-pink/30 border border-oat hover:border-dusty-rose/60 rounded-[2px] transition-colors">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs font-ui uppercase tracking-wider text-taupe font-semibold">
                Rollover Getaway Fund
              </span>
              <span className="font-num text-xs text-burgundy font-semibold">Ready</span>
            </div>
            <span className="font-num text-2xl font-semibold text-charcoal block">
              {wallet.vault?.rolloverBalanceFormatted ?? '$120.00'}
            </span>
            <span className="text-[11px] text-taupe font-ui mt-1 block">
              Accumulated unspent weekend money rolling towards your next big holiday.
            </span>
          </div>
        </div>
      </div>

      {/* Mood Check-In Stamps elevated in crisp-white */}
      <div className="bg-crisp-white border border-oat p-6 rounded-surface shadow-lift">
        <h3 className="font-display text-base font-semibold text-charcoal mb-1">
          How was your week{getStoredUser()?.name ? `, ${getStoredUser()!.name.split(' ')[0]}` : ''}?
        </h3>
        <p className="text-xs text-taupe font-ui mb-4">
          Stamping your mood reorders suggestions so low-effort spots lead when you're drained.
        </p>

        <div className="grid grid-cols-3 gap-3">
          {(
            [
              { id: 'drained', label: 'Drained', desc: 'Rough week. Calm ideas first.' },
              { id: 'okay', label: 'Okay', desc: 'Balanced rhythm and social energy.' },
              { id: 'great', label: 'Great', desc: 'Ready for new adventures & stretch.' }
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => handleMoodSelect(m.id)}
              className={`p-3 text-left border rounded-[2px] transition-all ${
                selectedMood === m.id
                  ? 'bg-blush-pink border-burgundy shadow-lift'
                  : 'bg-sand/40 border-oat hover:bg-blush-pink/40 hover:border-dusty-rose'
              }`}
            >
              <span className="block font-ui font-semibold text-sm text-charcoal mb-0.5">
                {m.label}
              </span>
              <span className="block text-[11px] text-taupe leading-tight">{m.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {/* B2 & B3: Subscription Audit & Cancel Modal / Sheet */}
      {showAuditSheet && audit && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          onClick={() => {
            setShowAuditSheet(false);
            setCancelPreview(null);
          }}
        >
          <div
            className="bg-crisp-white border border-oat w-full max-w-3xl rounded-surface p-6 shadow-lift max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className="text-xs font-ui uppercase tracking-wider text-taupe">
                  Ghost Subscription Audit
                </span>
                <h2 className="font-display text-xl font-semibold text-charcoal">
                  Found {audit.totalYearlyWasteFormatted} in unused recurring payments
                </h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAuditSheet(false);
                  setCancelPreview(null);
                }}
                className="text-taupe hover:text-charcoal text-sm"
              >
                ✕ Close
              </button>
            </div>

            <p className="text-xs text-taupe mb-4">
              Tick the subscriptions you want to cancel. The recovered monthly cash will be added
              directly back to your available weekend pool.
            </p>

            {/* Themed AG Grid */}
            <LedgerGrid<GhostSubscription>
              rowData={audit.ghostSubscriptions}
              columnDefs={auditColumns}
              onSelectionChanged={(selected) => setSelectedSubIds(selected.map((s) => s.id))}
              height={260}
            />

            {/* Guardian Preview & Hold-to-Seal */}
            {cancelPreview ? (
              <div className="mt-6 p-4 bg-blush-pink/40 border border-dusty-rose/70 rounded-[2px]">
                <h4 className="font-ui font-semibold text-sm text-burgundy mb-2">
                  Guardian Preview & Confirmation
                </h4>
                <p className="text-xs text-charcoal leading-relaxed mb-4">{cancelPreview.preview}</p>

                <div className="flex justify-center py-2">
                  <ApprovalSeal
                    onApprove={handleExecuteSeal}
                    disabled={executingSeal}
                    label={executingSeal ? 'Cancelling via PayPal...' : 'Hold to seal cancellation'}
                  />
                </div>
              </div>
            ) : (
              <div className="mt-6 flex justify-between items-center pt-4 border-t border-oat">
                <span className="text-xs text-taupe font-ui">
                  {selectedSubIds.length} subscriptions selected
                </span>
                <button
                  type="button"
                  disabled={selectedSubIds.length === 0}
                  onClick={handlePrepareCancel}
                  className={`px-5 py-2 font-ui text-sm font-medium rounded-[2px] transition-colors ${
                    selectedSubIds.length > 0
                      ? 'bg-burgundy text-parchment hover:bg-claret'
                      : 'bg-sand text-taupe border border-oat cursor-not-allowed'
                  }`}
                >
                  Cancel Selected
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* B4: Success Sheet */}
      {showSuccessSheet && cancelledResult && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          onClick={() => setShowSuccessSheet(false)}
        >
          <div
            className="bg-crisp-white border border-oat w-full max-w-md rounded-surface p-6 shadow-lift text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-full bg-moss/20 text-moss flex items-center justify-center mx-auto mb-3 text-2xl font-bold">
              ✓
            </div>
            <span className="text-[11px] font-ui uppercase font-semibold text-moss tracking-wider block">
              Cancelled in PayPal Sandbox
            </span>
            <h3 className="font-display text-xl font-semibold text-charcoal my-1">
              Reinvested {cancelledResult.yearlySaved}/year
            </h3>
            <p className="text-xs text-taupe mb-6 font-ui">
              {cancelledResult.count} subscriptions were cancelled via the PayPal Subscriptions API.
              Your available weekend fun money meter has rolled up!
            </p>

            <button
              type="button"
              onClick={() => {
                setShowSuccessSheet(false);
                onPlanClick();
              }}
              className="w-full py-2.5 bg-burgundy text-parchment font-ui text-sm font-semibold rounded-[2px] hover:bg-claret"
            >
              Plan Weekend with New Cash
            </button>
          </div>
        </div>
      )}

      {/* G1: Sunday Vault Decision Modal */}
      <SundayVaultModal
        isOpen={showVaultModal}
        amountMinor={wallet?.statement.freeForWeekendMinor}
        onClose={() => setShowVaultModal(false)}
        onSuccess={loadData}
      />
    </div>
  );
};
