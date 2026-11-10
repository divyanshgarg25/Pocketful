import React from 'react';
import { LedgerRule } from './LedgerRule';

interface RuledPlaceholderProps {
  message?: string;
  rows?: number;
  className?: string;
}

export const RuledPlaceholder: React.FC<RuledPlaceholderProps> = ({
  message = 'Pip is consulting your ledger...',
  rows = 3,
  className = ''
}) => {
  return (
    <div
      className={`w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12 ${className}`}
      role="status"
      aria-live="polite"
      aria-label={message}
    >
      <div className="bg-parchment border border-oat p-6 sm:p-8 rounded-surface shadow-lift">
        {/* Top Header Placeholder */}
        <div className="flex justify-between items-center mb-6">
          <div className="space-y-2">
            <div className="h-3 w-32 bg-oat/40 rounded-[2px] animate-pulse" />
            <div className="h-6 w-48 bg-sand/60 rounded-[2px] animate-pulse" />
          </div>
          <div className="h-7 w-24 bg-oat/30 rounded-[2px] animate-pulse" />
        </div>

        <LedgerRule variant="single" className="my-4" />

        {/* Ruled Skeleton Lines */}
        <div className="space-y-4 my-6">
          {Array.from({ length: rows }).map((_, idx) => (
            <div key={idx} className="flex justify-between items-center py-2 border-b border-oat/50">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 bg-oat/50 rounded-full" />
                <div
                  className="h-3.5 bg-oat/40 rounded-[2px] animate-pulse"
                  style={{ width: `${140 + (idx % 3) * 60}px` }}
                />
              </div>
              <div className="h-4 w-16 bg-sand/80 rounded-[2px] animate-pulse" />
            </div>
          ))}
        </div>

        <LedgerRule variant="double" className="my-4" />

        {/* Pip Consideration Note */}
        <p className="text-xs text-taupe font-ui italic text-center mt-4 flex items-center justify-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-burgundy/60 animate-pulse" />
          <span>{message}</span>
        </p>
      </div>
    </div>
  );
};
