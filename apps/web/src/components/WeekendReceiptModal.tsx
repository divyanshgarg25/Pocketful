import { logError } from '../lib/log';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { LedgerRule } from './LedgerRule';
import { useModalA11y } from '../lib/useModalA11y';

interface WeekendReceiptModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ReceiptData {
  receipt: {
    week: string;
    userName: string;
    items: Array<{
      name: string;
      category: string;
      amountFormatted: string;
      label: string;
    }>;
    totalSpentFormatted: string;
    recoveredFormatted: string;
    comfortZoneGrowth: string;
    doubleRuleTotal: string;
    issuedAt: string;
  };
}

export const WeekendReceiptModal: React.FC<WeekendReceiptModalProps> = ({ isOpen, onClose }) => {
  const [data, setData] = useState<ReceiptData | null>(null);
  const [hideAmounts, setHideAmounts] = useState(false);
  const modalRef = useModalA11y(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    const fetchReceipt = async () => {
      try {
        const res = await apiFetch<ReceiptData>('/api/receipt/current');
        setData(res);
      } catch (err) {
        logError('Failed to load receipt:', err);
      }
    };
    fetchReceipt();
  }, [isOpen]);

  const handleDownloadReceipt = () => {
    if (!data) return;
    const lines = [
      '========================================',
      '           POCKETFUL LEDGER             ',
      '         Weekend Till Receipt           ',
      '========================================',
      `Issued To: ${data.receipt.userName}`,
      `Date:      ${new Date(data.receipt.issuedAt).toLocaleString()}`,
      `Period:    ${data.receipt.week}`,
      '----------------------------------------',
      ...data.receipt.items.map(
        (it) => `${it.name.padEnd(24)} ${it.amountFormatted.padStart(10)}`
      ),
      '----------------------------------------',
      `TOTAL SPENT:        ${data.receipt.totalSpentFormatted}`,
      `RECOVERED REINVEST: ${data.receipt.recoveredFormatted}`,
      `COMFORT FRONTIER:   ${data.receipt.comfortZoneGrowth}`,
      '========================================',
      'Reconciled via PayPal Sandbox & Guardian Safe'
    ].join('\n');

    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pocketful-receipt-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
        aria-labelledby="weekend-receipt-title"
        className="bg-parchment border border-oat w-full max-w-sm rounded-surface p-6 shadow-lift relative outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Perforated Brass Tear Edge */}
        <div className="border-t-2 border-dashed border-brass mb-4 -mx-6" />

        <div className="flex justify-between items-start mb-4">
          <div>
            <span className="text-[10px] font-ui uppercase tracking-widest text-taupe block font-semibold">
              Weekend Till Receipt
            </span>
            <h3 id="weekend-receipt-title" className="font-display text-xl font-semibold text-ink">
              Pocketful Ledger
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

        {data ? (
          <div className="font-ui text-xs text-ink space-y-4">
            <div className="text-[11px] text-taupe font-num">
              Issued to: {data.receipt.userName} · {new Date(data.receipt.issuedAt).toLocaleDateString()}
            </div>

            <div className="divide-y divide-oat border-t border-b border-oat py-2 space-y-2">
              {data.receipt.items.length > 0 ? (
                data.receipt.items.map((item, idx) => (
                  <div key={idx} className="pt-2 flex justify-between items-center">
                    <div>
                      <span className="font-medium text-ink block">{item.name}</span>
                      <span className="text-[10px] text-taupe capitalize">{item.label}</span>
                    </div>
                    <span className="font-num font-semibold text-ink">
                      {hideAmounts ? '•••••' : item.amountFormatted}
                    </span>
                  </div>
                ))
              ) : (
                <div className="py-2 text-taupe text-center">Quiet Leaf Cafe — $50.00</div>
              )}
            </div>

            <div className="flex justify-between items-center text-taupe">
              <span>Recovered from Subscriptions:</span>
              <span className="font-num font-semibold text-moss">
                +{hideAmounts ? '••••' : data.receipt.recoveredFormatted}
              </span>
            </div>

            <div className="flex justify-between items-center text-taupe">
              <span>Comfort Zone:</span>
              <span className="font-medium text-burgundy">{data.receipt.comfortZoneGrowth}</span>
            </div>

            {/* Accountant Double Rule */}
            <LedgerRule double className="my-2" />

            <div className="flex justify-between items-center text-sm font-semibold">
              <span className="uppercase tracking-wider font-ui">Weekend Total</span>
              <span className="font-num text-base">
                {hideAmounts ? '••••••' : data.receipt.doubleRuleTotal}
              </span>
            </div>

            <div className="pt-4 flex items-center justify-between text-[11px] text-taupe border-t border-oat">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={hideAmounts}
                  onChange={(e) => setHideAmounts(e.target.checked)}
                  className="accent-burgundy"
                />
                <span>Hide amounts for sharing</span>
              </label>

              <button
                type="button"
                onClick={handleDownloadReceipt}
                className="text-burgundy underline hover:text-claret font-medium"
              >
                Save Receipt
              </button>
            </div>
          </div>
        ) : (
          <p className="text-center text-xs text-taupe py-6">Compiling till statement...</p>
        )}

        {/* Bottom Perforated Edge */}
        <div className="border-b-2 border-dashed border-brass mt-6 -mx-6" />
      </div>
    </div>
  );
};
