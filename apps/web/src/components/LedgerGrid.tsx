import React from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GridReadyEvent } from 'ag-grid-community';

import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';

interface LedgerGridProps<TData> {
  rowData: TData[];
  columnDefs: ColDef<TData>[];
  onSelectionChanged?: (selectedRows: TData[]) => void;
  onGridReady?: (params: GridReadyEvent) => void;
  height?: number | string;
  emptyMessage?: string;
}

export function LedgerGrid<TData extends Record<string, unknown>>({
  rowData,
  columnDefs,
  onSelectionChanged,
  onGridReady,
  height = 360,
  emptyMessage = 'No ledger entries found.'
}: LedgerGridProps<TData>): React.ReactElement {
  return (
    <div className="w-full border border-oat rounded-surface overflow-hidden bg-parchment shadow-lift">
      <div
        className="ag-theme-alpine w-full"
        style={{
          height: typeof height === 'number' ? `${height}px` : height,
          width: '100%'
        }}
      >
        <AgGridReact<TData>
          rowData={rowData}
          columnDefs={columnDefs}
          rowSelection="multiple"
          suppressRowClickSelection={false}
          headerHeight={40}
          rowHeight={48}
          animateRows={true}
          onSelectionChanged={(e) => {
            if (onSelectionChanged) {
              const selected = e.api.getSelectedRows();
              onSelectionChanged(selected);
            }
          }}
          onGridReady={onGridReady}
          overlayNoRowsTemplate={`<div class="p-6 text-center text-taupe font-ui text-sm">${emptyMessage}</div>`}
        />
      </div>
    </div>
  );
}
