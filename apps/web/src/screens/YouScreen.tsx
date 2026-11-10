import { logError } from '../lib/log';
import { notifyError } from '../lib/errors';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { LedgerRule } from '../components/LedgerRule';
import { ComfortZoneRings } from '../components/ComfortZoneRings';
import { toast } from '../lib/toast';
import { SecurityCard } from '../components/SecurityCard';
import { SecurityNotifications } from '../components/SecurityNotifications';

interface YouScreenProps {
  onOpenReceipt: () => void;
  onOpenVault: () => void;
}

interface LearnedLine {
  id: string;
  feature: string;
  text: string;
  evidence: string;
}

interface LearningProfile {
  lines: LearnedLine[];
  explorationLevel: 'off' | 'low' | 'normal';
  comfortRings: Array<{ category: string; monthAdded: string; label: string }>;
}

export const YouScreen: React.FC<YouScreenProps> = ({ onOpenReceipt, onOpenVault }) => {
  const [profile, setProfile] = useState<LearningProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [highlightedRing, setHighlightedRing] = useState<number | null>(null);

  const loadProfile = async () => {
    try {
      const res = await apiFetch<LearningProfile>('/api/learning/profile');
      setProfile(res);
    } catch (err) {
      logError('Failed to load learning profile:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProfile();
  }, []);

  const handleForget = async (feature: string) => {
    try {
      await apiFetch('/api/learning/forget', {
        method: 'POST',
        body: JSON.stringify({ feature })
      });
      await loadProfile();
      toast.success('Preference feature forgotten');
    } catch (err: unknown) {
      notifyError(err, 'Error forgetting feature');
    }
  };

  const handleReset = async () => {
    if (!confirm('Reset all learned preferences back to baseline priors?')) return;
    try {
      await apiFetch('/api/learning/reset', { method: 'POST' });
      await loadProfile();
      toast.success('Preferences reset to baseline');
    } catch (err: unknown) {
      notifyError(err, 'Reset error');
    }
  };

  if (loading || !profile) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 text-center font-ui text-taupe">
        Reading learned preference model...
      </div>
    );
  }

  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12">
      <div className="flex justify-between items-center mb-6">
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-1">
            Explainable AI
          </span>
          <h1 className="font-display text-2xl font-semibold text-charcoal">What Pip Learned About You</h1>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onOpenReceipt}
            className="px-3.5 py-1.5 bg-crisp-white border border-oat rounded-[2px] text-xs font-ui text-charcoal hover:bg-blush-pink hover:border-dusty-rose shadow-lift transition-colors"
          >
            Weekend Receipt
          </button>
          <button
            type="button"
            onClick={onOpenVault}
            className="px-3.5 py-1.5 bg-burgundy text-parchment rounded-[2px] text-xs font-ui hover:bg-claret shadow-lift transition-colors"
          >
            Sunday Vault
          </button>
        </div>
      </div>

      {/* F3: Comfort Zone Growth Tree Rings elevated in crisp-white */}
      <div className="bg-crisp-white border border-oat p-6 rounded-surface mb-8 shadow-lift flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="max-w-md">
          <span className="text-xs font-ui uppercase font-semibold text-burgundy tracking-wider block mb-1">
            Comfort Zone Growth Meter · Tree Rings
          </span>
          <h3 className="font-display text-lg font-semibold text-charcoal mb-1">
            Your tastes expanded by {profile.comfortRings.length} categories
          </h3>
          <p className="text-xs text-taupe font-ui leading-relaxed mb-4">
            Every concentric hairline ring represents a new experience category you successfully explored and
            rated positively. Older rings fade into settled habit priors as your comfort frontier expands outward.
          </p>

          {/* Interactive Categories Explorer */}
          <div className="flex flex-wrap gap-2">
            {profile.comfortRings.map((ring, idx) => (
              <button
                key={ring.category}
                type="button"
                onMouseEnter={() => setHighlightedRing(idx)}
                onMouseLeave={() => setHighlightedRing(null)}
                onClick={() => setHighlightedRing(highlightedRing === idx ? null : idx)}
                className={`px-2.5 py-1 border rounded-[2px] text-xs font-ui font-medium flex items-center gap-1.5 transition-colors cursor-pointer ${
                  highlightedRing === idx
                    ? 'bg-blush-pink border-dusty-rose text-burgundy shadow-lift'
                    : 'bg-sand/40 border-oat text-charcoal hover:bg-blush-pink/40 hover:border-dusty-rose'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor:
                      idx === profile.comfortRings.length - 1
                        ? 'var(--burgundy)'
                        : 'var(--maroon)'
                  }}
                />
                <span className="text-charcoal">{ring.label}</span>
                <span className="text-[10px] text-taupe">({ring.monthAdded})</span>
              </button>
            ))}
          </div>
        </div>

        {/* Dynamic Concentric Tree Rings SVG Component */}
        <div className="flex-shrink-0 w-[232px] bg-sand/20 border border-oat p-4 rounded-surface shadow-lift flex items-center justify-center">
          <ComfortZoneRings
            rings={profile.comfortRings}
            size={200}
            activeIndex={highlightedRing}
            onActiveChange={setHighlightedRing}
          />
        </div>
      </div>

      {/* F1: Learned About You Statements elevated in crisp-white */}
      <div className="bg-crisp-white border border-oat p-6 sm:p-8 rounded-surface shadow-lift mb-8">
        <h3 className="font-display text-lg font-semibold text-charcoal mb-2">Learned Ledger Rules</h3>
        <p className="text-xs text-taupe font-ui mb-6">
          Every statement below is backed by your actual transactions. You can inspect the evidence
          or wipe any learned preference at any time.
        </p>

        <div className="divide-y divide-oat">
          {profile.lines.map((line) => (
            <div key={line.id} className="py-4 flex justify-between items-start gap-4">
              <div className="border-l-2 border-dusty-rose/70 bg-blush-pink/20 pl-3 py-1.5 rounded-r-[2px]">
                <p className="font-display italic text-sm text-charcoal mb-1">"{line.text}"</p>
                <p className="text-xs text-taupe font-ui">Evidence: {line.evidence}</p>
              </div>

              <button
                type="button"
                onClick={() => handleForget(line.feature)}
                className="text-xs text-brick underline hover:text-maroon font-ui whitespace-nowrap"
              >
                Forget This
              </button>
            </div>
          ))}
        </div>

        <LedgerRule className="my-6" />

        <div className="flex justify-between items-center text-xs font-ui">
          <span className="text-taupe">Exploration setting: {profile.explorationLevel}</span>
          <button
            type="button"
            onClick={handleReset}
            className="text-brick underline hover:text-maroon"
          >
            Reset All Preferences to Priors
          </button>
        </div>
      </div>

      <SecurityCard />
      <SecurityNotifications />
    </div>
  );
};
