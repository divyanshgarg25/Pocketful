import { logError } from '../lib/log';
import { notifyError } from '../lib/errors';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { Badge } from '../components/Badge';
import { toast } from '../lib/toast';

interface OccasionItem {
  id: string;
  type: 'everyday' | 'weekend' | 'holiday' | 'getaway';
  title: string;
  date: string;
  budgetMinor: number;
  budgetFormatted: string;
  note: string;
}

interface HabitItem {
  id: string;
  category: string;
  time_bucket: string;
  day_of_week: number;
  typical_amount_minor: number;
  typicalAmountFormatted: string;
  occurrences: number;
}

interface OccasionsData {
  /** null when the region cannot be derived: show "set your region" instead of someone else's holidays. */
  region?: string | null;
  regionRequired?: boolean;
  regionMessage?: string;
  calendar: OccasionItem[];
  habits: HabitItem[];
  getawayStatus: {
    fundMinor: number;
    fundFormatted: string;
    isReady: boolean;
    margin: number;
    gapMinor: number;
  };
}

interface GetawayTourResponse {
  getawayFundMinor: number;
  getawayFundFormatted: string;
  recommendedTour: {
    id: string;
    name: string;
    state: string;
    kind: string;
    nights: number;
    travelHours: number;
    perDayMinor: number;
    perDayFormatted: string;
    totalMinor: number;
    totalFormatted: string;
    fundSharePct: number;
    fitsFund: boolean;
    whyItFits: string;
    disclaimer: string;
  };
  alternativeTours: Array<{
    id: string;
    name: string;
    state: string;
    kind: string;
    nights: number;
    totalFormatted: string;
    whyItFits: string;
  }>;
}

export const OccasionsScreen: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'now' | 'calendar' | 'rhythm' | 'getaway'>('now');
  const [data, setData] = useState<OccasionsData | null>(null);
  const [loading, setLoading] = useState(true);

  // Getaway itinerary
  const [getawayTour, setGetawayTour] = useState<GetawayTourResponse | null>(null);
  const [loadingGetaway, setLoadingGetaway] = useState(false);

  useEffect(() => {
    const loadOccasions = async () => {
      try {
        const res = await apiFetch<OccasionsData>('/api/occasions');
        setData(res);
      } catch (err) {
        logError('Failed to load occasions:', err);
      } finally {
        setLoading(false);
      }
    };
    loadOccasions();
  }, []);

  const handlePlanGetaway = async () => {
    setLoadingGetaway(true);
    try {
      const res = await apiFetch<GetawayTourResponse>('/api/getaways/plan', {
        method: 'POST',
        body: JSON.stringify({ nights: 3 })
      });
      setGetawayTour(res);
      toast.success('Getaway plan ready');
    } catch (err: unknown) {
      notifyError(err, 'Getaway planning error');
    } finally {
      setLoadingGetaway(false);
    }
  };

  if (loading || !data) {
    return (
      <div className="max-w-4xl mx-auto py-12 px-4 text-center font-ui text-taupe">
        Reading regional calendar and leisure rhythm...
      </div>
    );
  }

  const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return (
    <div className="w-full max-w-7xl mx-auto py-8 px-4 md:px-8 lg:px-12">
      {data.regionRequired && (
        <div role="status" className="mb-6 rounded-surface border border-oat bg-linen/60 px-4 py-3 text-sm font-ui text-ink">
          <p className="font-semibold">Set your region</p>
          <p className="text-taupe">
            {data.regionMessage ?? 'Set your region to see local holidays.'}
          </p>
        </div>
      )}
      {/* Top Segmented Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-1">
            Lifestyle Planning
          </span>
          <h1 className="font-display text-2xl font-semibold text-ink">The Occasions Engine</h1>
        </div>

        {/* Tab Switcher */}
        <div className="flex bg-sand border border-oat p-1 rounded-[2px]">
          {(
            [
              { id: 'now', label: 'Now' },
              { id: 'calendar', label: 'Calendar' },
              { id: 'rhythm', label: 'Your Rhythm' },
              { id: 'getaway', label: 'Getaway Fund' }
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1 text-xs font-ui rounded-[2px] transition-colors ${
                activeTab === t.id
                  ? 'bg-burgundy text-parchment font-medium shadow-lift border border-maroon'
                  : 'text-taupe hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* J1: Now View */}
      {activeTab === 'now' && (
        <div className="space-y-6">
          <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift">
            <span className="text-xs font-ui uppercase font-semibold text-burgundy tracking-wider block mb-1">
              Next Upcoming Moment
            </span>
            <h2 className="font-display text-xl font-semibold text-ink mb-1">
              Friday Dinner Outing
            </h2>
            <p className="text-xs text-taupe font-ui leading-relaxed mb-4">
              "You usually head out after 8:00 pm on Fridays. Estimated at $22.00. Quiet Leaf Cafe
              is roasting freshly this evening."
            </p>
            <div className="flex items-center gap-3">
              <Badge type="moss">Rhythm Aligned</Badge>
              <span className="font-num text-sm text-ink font-semibold">Budget: $22.00</span>
            </div>
          </div>
        </div>
      )}

      {/* J2: Calendar View */}
      {activeTab === 'calendar' && (
        <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift">
          <h2 className="font-display text-lg font-semibold text-ink mb-4">Occasions Calendar</h2>
          <div className="divide-y divide-oat">
            {data.calendar.map((item) => (
              <div key={item.id} className="py-3.5 flex justify-between items-center text-sm font-ui">
                <div>
                  <span className="font-medium text-ink block">{item.title}</span>
                  <span className="text-xs text-taupe">
                    {item.date} · {item.note}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-num text-sm font-semibold text-ink">
                    {item.budgetFormatted}
                  </span>
                  <Badge type={item.type === 'holiday' ? 'claret' : 'seeded'}>
                    {item.type}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* J3: Your Rhythm (Habits) */}
      {activeTab === 'rhythm' && (
        <div className="bg-parchment border border-oat p-6 rounded-surface shadow-lift">
          <h2 className="font-display text-lg font-semibold text-ink mb-1">Your Rhythm (Habits)</h2>
          <p className="text-xs text-taupe font-ui mb-4">
            Patterns mined from 3 or more occurrences in the last 6 weeks.
          </p>

          <div className="space-y-3">
            {data.habits.map((h) => (
              <div
                key={h.id}
                className="p-4 bg-sand border border-oat rounded-[2px] flex justify-between items-center"
              >
                <div>
                  <h4 className="font-ui font-semibold text-sm text-ink capitalize">
                    {daysOfWeek[h.day_of_week]} {h.time_bucket} {h.category}
                  </h4>
                  <span className="text-xs text-taupe font-ui">
                    Seen {h.occurrences} times · Median spend {h.typicalAmountFormatted}
                  </span>
                </div>
                <Badge type="moss">Active Habit</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* J4 & J5: Getaway Fund & Tour */}
      {activeTab === 'getaway' && (
        <div className="bg-parchment border border-oat p-6 sm:p-8 rounded-surface shadow-lift">
          <div className="flex justify-between items-start mb-6">
            <div>
              <span className="text-xs font-ui uppercase tracking-wider text-taupe block mb-1">
                Segregated Travel Pocket
              </span>
              <h2 className="font-display text-xl font-semibold text-ink">Getaway Fund</h2>
            </div>
            {data.getawayStatus.isReady ? (
              <Badge type="moss">Ready for a Trip</Badge>
            ) : (
              <Badge type="ochre">Not Yet Ready</Badge>
            )}
          </div>

          <div className="bg-sand border border-oat p-4 rounded-[2px] mb-6 flex justify-between items-center">
            <div>
              <span className="text-xs text-taupe uppercase tracking-wider font-ui block mb-0.5">
                Fund Balance
              </span>
              <span className="font-num text-3xl font-semibold text-ink">
                {data.getawayStatus.fundFormatted}
              </span>
            </div>
            <div className="text-right text-xs text-taupe font-ui">
              <span>Safety Margin: 120%</span>
              <p className="text-[11px] mt-0.5">Only this pocket can fund long-weekend trips.</p>
            </div>
          </div>

          <button
            type="button"
            disabled={!data.getawayStatus.isReady || loadingGetaway}
            onClick={handlePlanGetaway}
            className="w-full py-2.5 bg-burgundy text-parchment font-ui text-sm font-semibold rounded-[2px] hover:bg-claret active:bg-maroon transition-colors disabled:opacity-50"
          >
            {loadingGetaway ? 'Consulting Getaway Planner...' : 'Plan a Long-Weekend Getaway'}
          </button>

          {/* J5: Recommended Tour Ticket */}
          {getawayTour && (
            <div className="mt-8 border-t border-oat pt-6">
              <span className="text-xs font-ui uppercase font-semibold text-burgundy tracking-wider block mb-2">
                Recommended 3-Day Escape
              </span>
              <div className="bg-sand border border-oat p-5 rounded-surface shadow-lift">
                <div className="flex justify-between items-baseline mb-2">
                  <h3 className="font-display text-xl font-semibold text-ink">
                    {getawayTour.recommendedTour.name}, {getawayTour.recommendedTour.state}
                  </h3>
                  <span className="font-num text-lg font-semibold text-ink">
                    {getawayTour.recommendedTour.totalFormatted} total
                  </span>
                </div>

                <p className="text-xs text-taupe font-ui mb-3">
                  Travel time: ~{getawayTour.recommendedTour.travelHours} hrs · Per day:{' '}
                  {getawayTour.recommendedTour.perDayFormatted}
                </p>

                <p className="font-display italic text-sm text-ink mb-4">
                  "{getawayTour.recommendedTour.whyItFits}"
                </p>

                <div className="p-3 bg-parchment border border-oat rounded-[2px] text-xs text-taupe font-ui mb-4">
                  Note: {getawayTour.recommendedTour.disclaimer}
                </div>

                <div className="flex justify-between items-center text-xs">
                  <span className="font-ui text-taupe">
                    Uses {getawayTour.recommendedTour.fundSharePct}% of your Getaway Fund
                  </span>
                  <span className="font-semibold text-moss">Within Safety Margin</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
