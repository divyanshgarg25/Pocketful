import React from 'react';

interface RibbonTabProps {
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}

export const RibbonTab: React.FC<RibbonTabProps> = ({ label, active, onClick, count }) => {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-4 py-2.5 font-ui text-sm font-semibold tracking-wide transition-colors ${
        active ? 'text-burgundy' : 'text-taupe hover:text-ink'
      }`}
    >
      <span className="flex items-center gap-1.5">
        {label}
        {count !== undefined && count > 0 && (
          <span className="font-num text-[11px] bg-sand border border-oat px-1 py-0.2 rounded-[2px] text-ink">
            {count}
          </span>
        )}
      </span>

      {/* Hanging burgundy ribbon bookmark on active state */}
      {active && (
        <span className="absolute -bottom-2.5 left-1/2 -translate-x-1/2 w-4 h-3 bg-burgundy rounded-b-[2px] shadow-lift border-b border-x border-maroon flex items-end justify-center">
          <span className="w-1.5 h-1 bg-maroon rounded-b-[1px] mb-0.5" />
        </span>
      )}
    </button>
  );
};
