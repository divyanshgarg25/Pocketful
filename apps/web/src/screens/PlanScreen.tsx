import { logError } from '../lib/log';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { Ticket } from '../components/Ticket';
import { RuledPlaceholder } from '../components/RuledPlaceholder';

interface PlanScreenProps {
  onTakePlan: (
    suggestionId: string,
    venueName: string,
    estimatedCost: string,
    groupSize: number
  ) => void;
  onBackToLedger: () => void;
}

interface PlanSlot {
  slot: 'comfort' | 'stretch' | 'new';
  suggestionId: string;
  venue: {
    id: string;
    name: string;
    category: string;
    lat: number;
    lng: number;
  };
  distKm: number;
  costLowMinor: number;
  costHighMinor: number;
  costBasis: string;
  headline: string;
  why: string;
  reasonTags: string[];
}

interface PlanResponse {
  planId: string;
  budgetMinor: number;
  budgetFormatted: string;
  mood: 'drained' | 'okay' | 'great';
  groupSize: number;
  radiusKm: number;
  slots: PlanSlot[];
  notes: string[];
}

interface ComfortSpaceVenue {
  id: string;
  name: string;
  distKm: number;
  category: string;
  costRange: string;
}

interface ComfortSpaceData {
  profileSummary: string;
  venues: ComfortSpaceVenue[];
}

export const PlanScreen: React.FC<PlanScreenProps> = ({ onTakePlan, onBackToLedger }) => {
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [groupSize, setGroupSize] = useState(1);
  const [rejectingSlot, setRejectingSlot] = useState<PlanSlot | null>(null);
  const [learnedBanner, setLearnedBanner] = useState<string | null>(null);
  const [comfortSpaceData, setComfortSpaceData] = useState<ComfortSpaceData | null>(null);
  const [showComfortSpace, setShowComfortSpace] = useState(false);

  const fetchPlan = async (size = 1) => {
    setLoading(true);
    try {
      const res = await apiFetch<PlanResponse>('/api/plans', {
        method: 'POST',
        body: JSON.stringify({ groupSize: size })
      });
      setPlan(res);
    } catch (err) {
      logError('Plan generation failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPlan(groupSize);
  }, [groupSize]);

  const handleRejectReason = async (
    reason: 'too_far' | 'too_pricey' | 'not_my_vibe' | 'did_recently'
  ) => {
    if (!rejectingSlot) return;
    try {
      const res = await apiFetch<{ learnedLine: string }>(
        `/api/suggestions/${rejectingSlot.suggestionId}/feedback`,
        {
          method: 'POST',
          body: JSON.stringify({ outcome: 'rejected', rejectReason: reason })
        }
      );
      setLearnedBanner(res.learnedLine || 'Preference updated: suggestions re-ranking.');
      setRejectingSlot(null);
      // Re-generate plan with new weights
      await fetchPlan(groupSize);
    } catch (err) {
      logError('Feedback failed:', err);
    }
  };

  const handleAcceptSlot = async (slot: PlanSlot) => {
    try {
      apiFetch(`/api/suggestions/${slot.suggestionId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ outcome: 'accepted' })
      }).catch((err) => logError('Accept feedback failed:', err));
    } catch (err) {
      logError('Accept feedback failed:', err);
    }
    onTakePlan(
      slot.suggestionId,
      slot.venue.name,
      `$${(slot.costHighMinor / 100).toFixed(2)}`,
      groupSize
    );
  };

  const handleOpenComfortSpace = async () => {
    try {
      const data = await apiFetch<ComfortSpaceData>('/api/comfort-space', { method: 'POST' });
      setComfortSpaceData(data);
      setShowComfortSpace(true);
    } catch (err) {
      logError('Comfort space fetch failed:', err);
    }
  };

  if (loading && !plan) {
    return <RuledPlaceholder message="Pip is consulting your ledger and finding calm spots..." rows={3} />;
  }

  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12">
      {/* Top Header & Group Size Control */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <button
            type="button"
            onClick={onBackToLedger}
            className="text-xs font-ui text-taupe underline hover:text-ink mb-1 block"
          >
            ← Back to Wallet Statement
          </button>
          <h1 className="font-display text-2xl font-semibold text-charcoal">
            Your Weekend Blueprint
          </h1>
          {plan && (
            <p className="text-xs text-taupe font-ui mt-0.5">
              Budget: {plan.budgetFormatted} free · Mood: {plan.mood} · Reach: {plan.radiusKm} km
            </p>
          )}
        </div>

        {/* Group Size Stepper */}
        <div className="flex items-center gap-3 bg-sand/50 border border-oat px-3 py-1.5 rounded-[2px]">
          <span className="text-xs font-ui text-taupe uppercase tracking-wider font-semibold">
            Group Size:
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={groupSize <= 1}
              onClick={() => setGroupSize(Math.max(1, groupSize - 1))}
              className="w-6 h-6 border border-oat rounded-[2px] bg-crisp-white text-charcoal font-semibold flex items-center justify-center hover:bg-blush-pink hover:border-dusty-rose disabled:opacity-40 transition-colors"
            >
              -
            </button>
            <span className="font-num text-sm font-semibold w-4 text-center text-charcoal">{groupSize}</span>
            <button
              type="button"
              disabled={groupSize >= 10}
              onClick={() => setGroupSize(groupSize + 1)}
              className="w-6 h-6 border border-oat rounded-[2px] bg-crisp-white text-charcoal font-semibold flex items-center justify-center hover:bg-blush-pink hover:border-dusty-rose disabled:opacity-40 transition-colors"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {/* Learned Update Toast Banner */}
      {learnedBanner && (
        <div className="mb-6 p-3 bg-blush-pink border border-dusty-rose rounded-[2px] text-xs text-burgundy flex justify-between items-center shadow-lift">
          <span className="font-ui font-medium">{learnedBanner}</span>
          <button
            type="button"
            onClick={() => setLearnedBanner(null)}
            className="text-burgundy hover:text-maroon ml-4 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Notes / Warnings */}
      {plan?.notes && plan.notes.length > 0 && (
        <div className="mb-6 p-3 bg-sand border border-oat rounded-[2px] text-xs text-taupe font-ui">
          {plan.notes.join(' · ')}
        </div>
      )}

      {/* The Three Tickets Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {plan?.slots.map((slot) => (
          <Ticket
            key={slot.suggestionId}
            slot={slot.slot}
            name={slot.venue.name}
            category={slot.venue.category}
            distKm={slot.distKm}
            costRange={`$${(slot.costLowMinor / 100).toFixed(0)}–$${(
              slot.costHighMinor / 100
            ).toFixed(0)}`}
            headline={slot.headline}
            why={slot.why}
            reasonTags={slot.reasonTags}
            onAccept={() => handleAcceptSlot(slot)}
            onReject={() => setRejectingSlot(slot)}
          />
        ))}
      </div>

      {/* Comfort Space Button */}
      <div className="text-center pt-2">
        <button
          type="button"
          onClick={handleOpenComfortSpace}
          className="text-xs font-ui text-taupe underline hover:text-burgundy"
        >
          Need something extraordinarily quiet? Find my comfort space →
        </button>
      </div>

      {/* C4: Reject Reason Sheet */}
      {rejectingSlot && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          onClick={() => setRejectingSlot(null)}
        >
          <div
            className="bg-crisp-white border border-oat w-full max-w-md rounded-surface p-6 shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-semibold text-charcoal mb-1">
              What didn’t work with {rejectingSlot.venue.name}?
            </h3>
            <p className="text-xs text-taupe mb-4 font-ui">
              Tell Pip why. Your learning bandit updates only this specific feature immediately.
            </p>

            <div className="grid grid-cols-2 gap-2 mb-6">
              {(
                [
                  { id: 'too_far', label: 'Too Far', desc: 'Prioritize closer places' },
                  { id: 'too_pricey', label: 'Too Pricey', desc: 'Lower budget expectation' },
                  { id: 'not_my_vibe', label: 'Not My Vibe', desc: 'De-weight this category' },
                  { id: 'did_recently', label: 'Did It Recently', desc: 'Snooze for a while' }
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleRejectReason(opt.id)}
                  className="p-3 text-left bg-sand/30 border border-oat rounded-[2px] hover:bg-blush-pink hover:border-dusty-rose transition-colors"
                >
                  <span className="block text-xs font-semibold text-charcoal">{opt.label}</span>
                  <span className="block text-[10px] text-taupe">{opt.desc}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setRejectingSlot(null)}
              className="w-full py-1.5 border border-oat text-xs font-ui text-taupe rounded-[2px] hover:bg-sand/40 hover:text-charcoal transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* C5: Comfort Space Sheet */}
      {showComfortSpace && comfortSpaceData && (
        <div
          className="fixed inset-0 bg-ink/40 z-50 flex items-center justify-center p-4"
          onClick={() => setShowComfortSpace(false)}
        >
          <div
            className="bg-crisp-white border border-oat w-full max-w-xl rounded-surface p-6 shadow-lift"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-3">
              <h3 className="font-display text-lg font-semibold text-charcoal">Your Comfort Space</h3>
              <button
                type="button"
                onClick={() => setShowComfortSpace(false)}
                className="text-taupe hover:text-charcoal text-sm"
              >
                ✕ Close
              </button>
            </div>

            <p className="text-xs text-taupe font-ui mb-4">
              {comfortSpaceData.profileSummary}
            </p>

            <div className="space-y-3 mb-6">
              {comfortSpaceData.venues.map((v: ComfortSpaceVenue) => (
                <div
                  key={v.id}
                  className="p-3 bg-sand/30 hover:bg-blush-pink/30 border border-oat hover:border-dusty-rose/60 rounded-[2px] flex justify-between items-center transition-colors"
                >
                  <div>
                    <h4 className="font-ui font-semibold text-sm text-charcoal">{v.name}</h4>
                    <span className="text-[11px] text-taupe font-ui">
                      {v.distKm} km · {v.category} · {v.costRange}
                    </span>
                  </div>
                  <span className="text-xs font-ui text-moss font-semibold px-2 py-0.5 bg-crisp-white border border-moss rounded-[2px]">
                    Calm Sanctuary
                  </span>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowComfortSpace(false)}
              className="w-full py-2 bg-burgundy text-parchment text-xs font-medium rounded-[2px] hover:bg-claret"
            >
              Return to Plan
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
