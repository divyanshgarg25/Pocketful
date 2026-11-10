import React, { useState } from 'react';
import { RibbonTab } from './components/RibbonTab';
import { LedgerScreen } from './screens/LedgerScreen';
import { PlanScreen } from './screens/PlanScreen';
import { GroupScreen } from './screens/GroupScreen';
import { SpendScreen } from './screens/SpendScreen';
import { OccasionsScreen } from './screens/OccasionsScreen';
import { YouScreen } from './screens/YouScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { FriendPayScreen } from './screens/FriendPayScreen';
import { PipDrawer } from './components/PipDrawer';
import { ActionLogModal } from './components/ActionLogModal';
import { WeekendReceiptModal } from './components/WeekendReceiptModal';
import { SundayVaultModal } from './components/SundayVaultModal';
import { ToastContainer } from './lib/toast';
import { StepUpPromptHost } from './components/StepUpPromptHost';
import { getStoredToken, getStoredUser, signOut, SessionUser } from './lib/supabase';

export const App: React.FC = () => {
  // Check for public friend checkout URL path (/pay/:token)
  const currentPath = typeof window !== 'undefined' ? window.location.pathname : '';
  const isDirectPayUrl = currentPath.startsWith('/pay/');
  const directPayToken = isDirectPayUrl ? currentPath.replace('/pay/', '').split('/')[0] : null;

  // Session state
  const [hasSession, setHasSession] = useState<boolean>(() => Boolean(getStoredToken()));
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(() => getStoredUser());
  const [activeTab, setActiveTab] = useState<'ledger' | 'plan' | 'group' | 'spend' | 'occasions' | 'you'>('ledger');

  // Modals & Overlays
  const [isPipOpen, setIsPipOpen] = useState(false);
  const [isActionLogOpen, setIsActionLogOpen] = useState(false);
  const [isReceiptOpen, setIsReceiptOpen] = useState(false);
  const [isVaultOpen, setIsVaultOpen] = useState(false);

  // Group split cross-tab context
  const [groupContext, setGroupContext] = useState<{
    suggestionId?: string;
    venueName?: string;
    estimatedCost?: string;
    groupSize?: number;
  }>({});

  const [soloPlanNotice, setSoloPlanNotice] = useState<string | null>(null);

  React.useEffect(() => {
    const handleUnauthorized = () => {
      setHasSession(false);
      setCurrentUser(null);
    };
    window.addEventListener('pocketful:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('pocketful:unauthorized', handleUnauthorized);
  }, []);

  // If visiting public friend pay page directly via URL
  if (directPayToken) {
    return (
      <FriendPayScreen
        token={directPayToken}
        onBackToApp={() => {
          if (typeof window !== 'undefined') {
            window.location.pathname = '/';
          }
        }}
      />
    );
  }

  // If unauthenticated, show Onboarding Welcome & Supabase Auth Screen (Issue 1 & 3)
  if (!hasSession) {
    return (
      <OnboardingScreen
        onComplete={() => {
          setCurrentUser(getStoredUser());
          setHasSession(true);
        }}
      />
    );
  }

  const handleSignOut = async () => {
    await signOut();
    setCurrentUser(null);
    setHasSession(false);
  };

  return (
    <div className="min-h-screen bg-linen flex flex-col font-ui text-ink selection:bg-blush selection:text-maroon">
      <StepUpPromptHost />
      {/* Top Application Header */}
      <header className="border-b border-oat bg-parchment sticky top-0 z-40">
        <div className="w-full max-w-7xl mx-auto px-4 md:px-8 lg:px-12 h-16 flex items-center justify-between">
          {/* Logo & Brand Mark */}
          <div
            className="flex items-center gap-2.5 cursor-pointer"
            onClick={() => setActiveTab('ledger')}
          >
            <div className="w-8 h-8 rounded-full bg-burgundy border border-brass flex items-center justify-center shadow-lift">
              <span className="font-display italic text-parchment text-lg font-bold pb-0.5">p</span>
            </div>
            <div>
              <span className="font-display font-semibold text-lg text-ink tracking-tight block leading-none">
                Pocketful
              </span>
              <span className="text-[10px] text-taupe uppercase tracking-widest font-ui block mt-0.5">
                The Weekend Ledger
              </span>
            </div>
          </div>

          {/* User Profile Badge & System Control Actions */}
          <div className="flex items-center gap-2">
            {currentUser && (
              <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-sand border border-oat rounded-[2px] text-xs">
                <span className="w-2 h-2 rounded-full bg-moss" />
                <span className="font-medium text-ink">{currentUser.name}</span>
              </div>
            )}

            <button
              type="button"
              onClick={() => setIsActionLogOpen(true)}
              className="text-xs text-taupe hover:text-ink px-2.5 py-1.5 border border-oat rounded-[2px] bg-sand font-medium transition-colors"
            >
              Action Log
            </button>
            <button
              type="button"
              onClick={() => setIsReceiptOpen(true)}
              className="text-xs text-taupe hover:text-ink px-2.5 py-1.5 border border-oat rounded-[2px] bg-sand font-medium transition-colors"
            >
              Receipt
            </button>
            <button
              type="button"
              onClick={() => setIsPipOpen(!isPipOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-burgundy text-parchment rounded-[2px] text-xs font-semibold hover:bg-claret shadow-lift transition-colors"
            >
              <span className="font-display italic text-sm">p</span>
              <span>Pip Drawer</span>
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="text-xs text-taupe hover:text-brick px-2 py-1.5 font-medium transition-colors ml-1"
              title="Sign Out"
            >
              Sign Out
            </button>
          </div>
        </div>

        {/* Primary Ribbon Navigation Tabs */}
        <div className="w-full max-w-7xl mx-auto px-4 md:px-8 lg:px-12 flex gap-1 border-t border-oat overflow-x-auto">
          <RibbonTab
            label="Ledger"
            active={activeTab === 'ledger'}
            onClick={() => setActiveTab('ledger')}
          />
          <RibbonTab
            label="Plan"
            active={activeTab === 'plan'}
            onClick={() => setActiveTab('plan')}
          />
          <RibbonTab
            label="Group"
            active={activeTab === 'group'}
            onClick={() => setActiveTab('group')}
          />
          <RibbonTab
            label="Spend"
            active={activeTab === 'spend'}
            onClick={() => setActiveTab('spend')}
          />
          <RibbonTab
            label="Occasions"
            active={activeTab === 'occasions'}
            onClick={() => setActiveTab('occasions')}
          />
          <RibbonTab
            label="You"
            active={activeTab === 'you'}
            onClick={() => setActiveTab('you')}
          />
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1">
        {soloPlanNotice && activeTab === 'ledger' && (
          <div className="w-full max-w-7xl mx-auto px-4 md:px-8 lg:px-12 pt-6">
            <div className="p-3.5 bg-blush-pink border border-dusty-rose rounded-[2px] text-xs text-burgundy flex justify-between items-center shadow-lift">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-moss flex-shrink-0" />
                <span className="font-ui font-medium">{soloPlanNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setSoloPlanNotice(null)}
                className="text-burgundy hover:text-maroon font-bold text-xs ml-4"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {activeTab === 'ledger' && (
          <LedgerScreen
            onPlanClick={() => setActiveTab('plan')}
            onOpenChat={() => setIsPipOpen(true)}
          />
        )}
        {activeTab === 'plan' && (
          <PlanScreen
            onTakePlan={(suggestionId, venueName, estimatedCost, groupSize) => {
              if (groupSize >= 2) {
                // Multi-person activity: Route to group split screen
                setGroupContext({ suggestionId, venueName, estimatedCost, groupSize });
                setSoloPlanNotice(null);
                setActiveTab('group');
              } else {
                // Solo outing: Lock in plan without group splitting
                setSoloPlanNotice(
                  `Solo plan confirmed: ${venueName} (${estimatedCost}). Added to your weekend itinerary!`
                );
                setActiveTab('ledger');
              }
            }}
            onBackToLedger={() => setActiveTab('ledger')}
          />
        )}
        {activeTab === 'group' && (
          <GroupScreen
            initialSuggestionId={groupContext.suggestionId}
            initialVenueName={groupContext.venueName}
            initialTotal={groupContext.estimatedCost}
            initialGroupSize={groupContext.groupSize}
            onBackToPlan={() => setActiveTab('plan')}
          />
        )}
        {activeTab === 'spend' && <SpendScreen />}
        {activeTab === 'occasions' && <OccasionsScreen />}
        {activeTab === 'you' && (
          <YouScreen
            onOpenReceipt={() => setIsReceiptOpen(true)}
            onOpenVault={() => setIsVaultOpen(true)}
          />
        )}
      </main>

      {/* Footer Ledger Watermark */}
      <footer className="border-t border-oat py-6 bg-parchment text-center text-xs text-taupe font-ui">
        <div className="w-full max-w-7xl mx-auto px-4 md:px-8 lg:px-12">
          <p>Pocketful · PayPal AI Hackathon · Bound Ledger Edition · 100% Deterministic Guardian Safe</p>
        </div>
      </footer>

      {/* Global Drawers & Modals */}
      <PipDrawer
        isOpen={isPipOpen}
        onClose={() => setIsPipOpen(false)}
        onNavigateTab={(tab) => setActiveTab(tab)}
      />
      <ActionLogModal isOpen={isActionLogOpen} onClose={() => setIsActionLogOpen(false)} />
      <WeekendReceiptModal isOpen={isReceiptOpen} onClose={() => setIsReceiptOpen(false)} />
      <SundayVaultModal
        isOpen={isVaultOpen}
        onClose={() => setIsVaultOpen(false)}
        onSuccess={() => setIsReceiptOpen(true)}
      />
      <ToastContainer />
    </div>
  );
};
