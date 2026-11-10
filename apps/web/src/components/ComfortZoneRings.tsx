import React, { useState, useRef, useCallback } from 'react';

export interface ComfortRingData {
  category: string;
  monthAdded: string;
  label: string;
}

interface ComfortZoneRingsProps {
  rings: ComfortRingData[];
  size?: number;
  activeIndex?: number | null;
  onActiveChange?: (index: number | null) => void;
  onRingClick?: (ring: ComfortRingData, index: number) => void;
  className?: string;
}

export const ComfortZoneRings: React.FC<ComfortZoneRingsProps> = ({
  rings = [],
  size = 200,
  activeIndex: controlledActiveIndex,
  onActiveChange,
  onRingClick,
  className = ''
}) => {
  const [internalActiveIndex, setInternalActiveIndex] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const isControlled = controlledActiveIndex !== undefined;
  const activeRingIndex = isControlled ? controlledActiveIndex : internalActiveIndex;

  const setActive = useCallback(
    (idx: number | null) => {
      if (!isControlled) {
        setInternalActiveIndex(idx);
      }
      onActiveChange?.(idx);
    },
    [isControlled, onActiveChange]
  );

  const ringCount = rings.length;
  const viewBoxSize = 220;
  const center = viewBoxSize / 2; // 110

  // Geometric boundary bounds for concentric rings
  const minRadius = 36;
  const maxRadius = 92;

  // Calculate radius for each dynamic ring
  const getRadius = useCallback(
    (index: number): number => {
      if (ringCount <= 1) return (minRadius + maxRadius) / 2;
      const step = (maxRadius - minRadius) / (ringCount - 1);
      return minRadius + index * step;
    },
    [ringCount, minRadius, maxRadius]
  );

  // Band step for continuous annular zone detection
  const bandStep = ringCount > 1 ? (maxRadius - minRadius) / (ringCount - 1) : 30;
  const halfStep = bandStep / 2;

  // Color sequence using exact design tokens
  const getRingColor = (index: number): string => {
    const isNewest = index === ringCount - 1;
    if (isNewest) {
      return 'var(--burgundy)';
    }
    const palette = ['var(--maroon)', 'var(--claret)', 'var(--brass)', 'var(--moss)'];
    return palette[index % palette.length] ?? 'var(--maroon)';
  };

  const getRingDashArray = (index: number): string | undefined => {
    const isNewest = index === ringCount - 1;
    // Newest exploratory ring carries a delicate dashed boundary
    return isNewest ? '6 3' : undefined;
  };

  // Continuous radial distance tracking with strict annular hysteresis (zero dead-zones, zero first-hover jump)
  const handleSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || ringCount === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * viewBoxSize;
    const svgY = ((e.clientY - rect.top) / rect.height) * viewBoxSize;
    const dx = svgX - center;
    const dy = svgY - center;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Strict boundary checks:
    // Core limit: cursor inside center prior anchor
    const innerBound = minRadius - halfStep;
    // Outer limit: cursor outside outermost tree ring frontier
    const outerBound = maxRadius + halfStep;

    if (dist < innerBound || dist > outerBound) {
      if (activeRingIndex !== null) {
        setActive(null);
      }
      return;
    }

    // Determine which annular band the cursor is in
    let matchedIndex = 0;
    let minDiff = Infinity;
    for (let i = 0; i < ringCount; i++) {
      const r = getRadius(i);
      const diff = Math.abs(dist - r);
      if (diff < minDiff) {
        minDiff = diff;
        matchedIndex = i;
      }
    }

    if (activeRingIndex !== matchedIndex) {
      setActive(matchedIndex);
    }
  };

  const handleSvgMouseLeave = () => {
    if (activeRingIndex !== null) {
      setActive(null);
    }
  };

  const categoriesSummary = rings.map((r) => `${r.label} (${r.monthAdded})`).join(', ');

  return (
    <div className={`flex flex-col items-center select-none ${className}`}>
      {/* SVG Concentric Tree Rings Graphic */}
      <div className="relative flex items-center justify-center">
        <svg
          ref={svgRef}
          width={size}
          height={size}
          viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
          className="overflow-visible cursor-crosshair"
          role="img"
          aria-label={`Comfort Zone Tree Rings: ${ringCount} concentric exploration rings (${categoriesSummary})`}
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={handleSvgMouseLeave}
          onClick={() => {
            if (activeRingIndex !== null && rings[activeRingIndex]) {
              onRingClick?.(rings[activeRingIndex], activeRingIndex);
            }
          }}
        >
          <title>Comfort Zone Growth Tree Rings</title>
          <desc>
            {`Concentric hairline rings representing ${ringCount} explored categories: ${categoriesSummary}`}
          </desc>

          {/* 1. Subtle Cartographic Center Crosshairs */}
          <line
            x1={center - 12}
            y1={center}
            x2={center + 12}
            y2={center}
            stroke="var(--oat)"
            strokeWidth="0.75"
            pointerEvents="none"
          />
          <line
            x1={center}
            y1={center - 12}
            x2={center}
            y2={center + 12}
            stroke="var(--oat)"
            strokeWidth="0.75"
            pointerEvents="none"
          />

          {/* 2. Core Origin Pip / Prior Baseline */}
          <circle
            cx={center}
            cy={center}
            r={18}
            fill="var(--sand)"
            stroke="var(--oat)"
            strokeWidth="1"
            pointerEvents="none"
          />
          <circle
            cx={center}
            cy={center}
            r={9}
            fill="var(--parchment)"
            stroke="var(--brass)"
            strokeWidth="1"
            pointerEvents="none"
          />
          <circle
            cx={center}
            cy={center}
            r={3.5}
            fill="var(--burgundy)"
            pointerEvents="none"
          />

          {/* Baseline Prior Hairline Guideline */}
          <circle
            cx={center}
            cy={center}
            r={minRadius - 8}
            fill="none"
            stroke="var(--oat)"
            strokeWidth="0.75"
            strokeDasharray="2 3"
            opacity="0.8"
            pointerEvents="none"
          />

          {/* 3. Dynamically Generated N Concentric Tree Rings (All elements permanently rendered in DOM) */}
          {rings.map((ring, idx) => {
            const r = getRadius(idx);
            const isHovered = activeRingIndex === idx;
            const strokeColor = getRingColor(idx);
            const dashArray = getRingDashArray(idx);

            return (
              <g key={ring.category + idx} pointerEvents="none">
                {/* Visual Highlight Halo (Permanent DOM node; opacity transitioned to prevent mount reflow) */}
                <circle
                  cx={center}
                  cy={center}
                  r={r}
                  fill="none"
                  stroke="var(--blush)"
                  strokeWidth="12"
                  strokeOpacity={isHovered ? 0.45 : 0}
                  pointerEvents="none"
                  className="transition-opacity duration-150"
                />

                {/* Primary Concentric Hairline Ring */}
                <circle
                  cx={center}
                  cy={center}
                  r={r}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={isHovered ? 2.5 : 1.25}
                  strokeDasharray={dashArray}
                  strokeOpacity={
                    activeRingIndex === null
                      ? 0.85
                      : isHovered
                      ? 1
                      : 0.35 // Gently dims non-active rings for focus
                  }
                  pointerEvents="none"
                  className="transition-all duration-150"
                />

                {/* Growth Boundary Registration Tick Mark */}
                <circle
                  cx={center + r}
                  cy={center}
                  r={isHovered ? 3.5 : 2}
                  fill={strokeColor}
                  stroke="var(--parchment)"
                  strokeWidth="0.75"
                  pointerEvents="none"
                  className="transition-all duration-150"
                />
              </g>
            );
          })}

          {/* Outer Frontier Guideline */}
          <circle
            cx={center}
            cy={center}
            r={maxRadius + 8}
            fill="none"
            stroke="var(--oat)"
            strokeWidth="0.5"
            strokeDasharray="2 4"
            opacity="0.6"
            pointerEvents="none"
          />
        </svg>
      </div>

      {/* Dynamic Active Ring Marginalia Note (Rigid DOM structure, zero vertical jump) */}
      <div className="mt-2 text-center h-10 flex flex-col items-center justify-center pointer-events-none">
        <span className="font-display italic text-xs text-ink block font-semibold transition-opacity duration-150">
          {activeRingIndex !== null && rings[activeRingIndex]
            ? `"${rings[activeRingIndex].label}"`
            : `${ringCount} concentric categories explored`}
        </span>
        <span className="font-ui text-[10px] text-taupe uppercase tracking-wider block transition-opacity duration-150 mt-0.5">
          {activeRingIndex !== null && rings[activeRingIndex]
            ? `Ring ${activeRingIndex + 1} of ${ringCount} · Added ${rings[activeRingIndex].monthAdded}`
            : 'Hover any ring to inspect'}
        </span>
      </div>
    </div>
  );
};
