import { logError } from '../lib/log';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { LedgerGrid } from './LedgerGrid';
import { useModalA11y } from '../lib/useModalA11y';
import type { ColDef } from 'ag-grid-community';

interface ActionLogModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AuditLogRow {
  id: number;
  agent: string;
  action: string;
  approval_id?: string | null;
  result?: Record<string, unknown> | null;
  created_at: string;
  [key: string]: unknown;
}

export const ActionLogModal: React.FC<ActionLogModalProps> = ({ isOpen, onClose }) => {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const modalRef = useModalA11y(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    const fetchLogs = async () => {
      try {
        const res = await apiFetch<{ logs: AuditLogRow[] }>('/api/audit');
        setLogs(res.logs);
      } catch (err) {
        logError('Failed to load audit logs:', err);
      }
    };
    fetchLogs();
  }, [isOpen]);

  const exportCSV = () => {
    if (logs.length === 0) return;
    const headers = ['ID', 'Timestamp', 'Agent', 'Action', 'Approval ID'];
    const rows = logs.map((l) => [
      l.id,
      l.created_at,
      l.agent,
      l.action,
      l.approval_id ?? 'None'
    ]);
    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `pocketful_audit_log_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const auditColumns: ColDef<AuditLogRow>[] = [
    {
      headerName: 'Time',
      field: 'created_at',
      width: 160,
      cellClass: 'font-num text-xs text-taupe',
      valueFormatter: (p) => new Date(p.value as string).toLocaleTimeString()
    },
    {
      headerName: 'Agent',
      field: 'agent',
      width: 120,
      cellRenderer: (p: { value: string }) => (
        <span className="font-ui font-semibold text-xs text-burgundy uppercase tracking-wider">
          {p.value}
        </span>
      )
    },
    {
      headerName: 'Action Executed',
      field: 'action',
      flex: 1.5,
      cellRenderer: (p: { value: string }) => (
        <span className="font-ui text-xs font-medium text-ink">{p.value}</span>
      )
    },
    {
      headerName: 'Approval ID',
      field: 'approval_id',
      width: 130,
      cellClass: 'font-num text-xs text-taupe',
      valueFormatter: (p) => (p.value ? String(p.value).slice(0, 8) : '—')
    }
  ];

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
        aria-labelledby="action-log-title"
        className="bg-parchment border border-oat w-full max-w-3xl rounded-surface p-6 shadow-lift max-h-[90vh] flex flex-col outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-between items-start mb-4">
          <div>
            <span className="text-xs font-ui uppercase tracking-wider text-taupe">
              Immutable Governance
            </span>
            <h2 id="action-log-title" className="font-display text-xl font-semibold text-ink">
              Action & Financial Audit Log
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-taupe hover:text-ink text-sm p-1 rounded-[2px] focus:outline-none focus:ring-1 focus:ring-burgundy"
            aria-label="Close dialog"
          >
            ✕ Close
          </button>
        </div>

        <p className="text-xs text-taupe font-ui mb-4">
          Every agent action, financial approval, and PayPal API execution is strictly append-only.
          No edit or delete endpoints exist.
        </p>

        <div className="flex-1 overflow-hidden mb-4">
          <LedgerGrid<AuditLogRow>
            rowData={logs}
            columnDefs={auditColumns}
            height={320}
            emptyMessage="No audit entries logged."
          />
        </div>

        <div className="flex justify-between items-center pt-3 border-t border-oat text-xs">
          <span className="text-taupe font-ui">{logs.length} logged actions recorded</span>
          <button
            type="button"
            onClick={exportCSV}
            className="px-4 py-1.5 bg-sand border border-oat rounded-[2px] font-ui font-medium text-ink hover:bg-parchment"
          >
            Export as CSV
          </button>
        </div>
      </div>
    </div>
  );
};
