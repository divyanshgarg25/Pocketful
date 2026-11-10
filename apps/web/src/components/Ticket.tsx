import React from 'react';

export interface TicketProps {
  slot: 'comfort' | 'stretch' | 'new';
  name: string;
  category: string;
  distKm: number;
  costRange: string;
  headline: string;
  why: string;
  reasonTags: string[];
  onAccept?: () => void;
  onReject?: () => void;
}

export const Ticket: React.FC<TicketProps> = ({
  slot,
  name,
  category,
  distKm,
  costRange,
  headline,
  why,
  reasonTags,
  onAccept,
  onReject
}) => {
  const slotBadge = {
    comfort: { label: 'Comfort Pick', color: 'border-oat text-charcoal bg-sand/50' },
    stretch: { label: 'Stretch Pick', color: 'border-dusty-rose text-claret bg-blush-pink' },
    new: { label: 'New Experience', color: 'border-burgundy text-burgundy bg-blush-pink' }
  }[slot];

  // Ticket Edge style
  const edgeClass =
    slot === 'comfort'
      ? 'border-solid'
      : slot === 'stretch'
      ? 'border-solid relative after:content-[""] after:absolute after:-right-2 after:top-1/2 after:-translate-y-1/2 after:w-4 after:h-4 after:bg-linen after:rounded-full after:border after:border-oat'
      : 'border-dashed';

  return (
    <div
      className={`bg-crisp-white border border-oat p-5 rounded-surface flex flex-col justify-between shadow-lift transition-all ${edgeClass}`}
    >
      <div>
        {/* Header Ribbon / Tag */}
        <div className="flex justify-between items-center mb-3">
          <span
            className={`text-[11px] font-ui uppercase tracking-wider font-semibold px-2 py-0.5 border rounded-[2px] ${slotBadge.color}`}
          >
            {slotBadge.label}
          </span>
          <span className="font-num text-xs text-taupe">{distKm} km away</span>
        </div>

        {/* Venue Title & Headline in magazine charcoal */}
        <h3 className="font-ui text-lg font-semibold text-charcoal leading-tight mb-1">{name}</h3>
        <p className="text-xs text-taupe font-ui uppercase tracking-wider mb-3">{category}</p>

        <p className="text-sm font-ui font-medium text-charcoal mb-3">{headline}</p>

        {/* Marginalia Note with dusty-rose vertical rule and soft blush-pink background */}
        <div className="border-l-2 border-dusty-rose/60 bg-blush-pink/30 pl-3 py-1.5 rounded-r-[2px] my-3">
          <p className="font-display italic text-sm text-charcoal/90 leading-relaxed">"{why}"</p>
        </div>

        {/* Reason Chips & Estimated Cost */}
        <div className="flex flex-wrap gap-1.5 mt-3 mb-2">
          {reasonTags.map((tag) => (
            <span
              key={tag}
              className="text-[10px] font-ui bg-parchment text-charcoal px-1.5 py-0.5 rounded-[2px] border border-oat hover:bg-blush-pink hover:border-dusty-rose hover:text-burgundy transition-colors"
            >
              {tag.replace('_', ' ')}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-oat flex justify-between items-center">
        <div>
          <span className="text-[10px] font-ui uppercase tracking-wider text-taupe block">
            Estimated Cost
          </span>
          <span className="font-num text-base font-semibold text-charcoal">{costRange}</span>
        </div>

        <div className="flex gap-2">
          {onReject && (
            <button
              type="button"
              onClick={onReject}
              className="px-2.5 py-1 text-xs border border-oat text-taupe rounded-[2px] hover:bg-blush-pink hover:border-dusty-rose hover:text-charcoal transition-colors font-ui"
            >
              Not for me
            </button>
          )}
          {onAccept && (
            <button
              type="button"
              onClick={onAccept}
              className="px-3.5 py-1 text-xs bg-burgundy text-parchment font-medium rounded-[2px] hover:bg-claret active:bg-maroon transition-colors font-ui"
            >
              Take this
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
