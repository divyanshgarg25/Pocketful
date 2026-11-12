import { logError } from '../lib/log';
import React, { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api';
import { LedgerRule } from '../components/LedgerRule';
import { Badge } from '../components/Badge';
import { demoIdentity } from '../lib/demo';
import { signIn, signUp, signInDemo, setStoredSession, getStoredUser } from '../lib/supabase';

interface OnboardingScreenProps {
  onComplete: () => void;
}

export const OnboardingScreen: React.FC<OnboardingScreenProps> = ({ onComplete }) => {
  const [step, setStep] = useState(1);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');

  // Auth form state
  const [email, setEmail] = useState(demoIdentity?.email ?? '');
  const [password, setPassword] = useState(demoIdentity?.password ?? '');
  const [name, setName] = useState(demoIdentity?.name ?? '');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  // Vibe Check & Boundaries state
  const [address, setAddress] = useState('');
  const [reachKm, setReachKm] = useState(8);
  const [guiltFreeCapMinor, setGuiltFreeCapMinor] = useState(15000); // $150.00
  const [interests, setInterests] = useState<string[]>(['cafes', 'gaming', 'sports', 'outdoors']);
  const [vibePref, setVibePref] = useState<'quiet' | 'lively' | 'mixed'>('quiet');
  const [socialPref, setSocialPref] = useState<'solo' | 'social' | 'mixed'>('mixed');
  const [optInMood, setOptInMood] = useState(true);
  const [optInTracking, setOptInTracking] = useState(true);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [matchedCoords, setMatchedCoords] = useState<{ lat: number; lng: number; label: string } | null>(null);

  const availableInterests = [
    { id: 'cafes', label: 'Cafes & Coffee' },
    { id: 'gaming', label: 'Board Games & Arcades' },
    { id: 'sports', label: 'Climbing & Turf' },
    { id: 'workshops', label: 'Ceramics & Craft' },
    { id: 'arts', label: 'Cinema & Galleries' },
    { id: 'outdoors', label: 'Forest Trails & Parks' }
  ];

  const toggleInterest = (id: string) => {
    if (interests.includes(id)) {
      setInterests(interests.filter((i) => i !== id));
    } else {
      setInterests([...interests, id]);
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await signIn(email, password);
      setStoredSession(res.token, res.user);
      onComplete();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await signUp(email, password, name);
      setStoredSession(res.token, res.user);
      setStep(2);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign up failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDemoSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await signInDemo();
      setStoredSession(res.token, res.user);
      onComplete();  // skip onboarding wizard, go straight to dashboard
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Demo sign in failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleUseMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setLocationNotice('Geolocation is not supported by your browser.');
      return;
    }
    setLocating(true);
    setLocationNotice('Detecting coordinates via GPS...');

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        try {
          const res = await apiFetch<{ lat: number; lng: number; displayName: string }>(
            `/api/places/reverse-geocode?lat=${latitude}&lng=${longitude}`
          );
          setAddress(res.displayName);
          setMatchedCoords({
            lat: res.lat,
            lng: res.lng,
            label: res.displayName
          });
          setLocationNotice(null);
        } catch {
          const fallbackLabel = `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
          setAddress(fallbackLabel);
          setMatchedCoords({
            lat: latitude,
            lng: longitude,
            label: fallbackLabel
          });
          setLocationNotice(null);
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        if (err.code === 1) {
          setLocationNotice('Location permission was denied. Please enter your neighborhood or city above.');
        } else if (err.code === 2) {
          setLocationNotice('Position unavailable. Please enter your address above.');
        } else if (err.code === 3) {
          setLocationNotice('Location detection timed out. Please enter your address above.');
        } else {
          setLocationNotice('Could not retrieve location. Please enter your address above.');
        }
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  };

  useEffect(() => {
    if (!address.trim() || step !== 2) return;
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<{ lat: number; lng: number; displayName: string }>(
          `/api/places/geocode?query=${encodeURIComponent(address)}`
        );
        if (res && typeof res.lat === 'number' && typeof res.lng === 'number') {
          setMatchedCoords({
            lat: res.lat,
            lng: res.lng,
            label: res.displayName
          });
        }
      } catch {
        // Retain current coordinates
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [address, step]);

  const handleFinish = async () => {
    if (!address.trim()) {
      setAuthError('Enter your neighbourhood or city so we can find places near you.');
      return;
    }
    setLoading(true);
    setAuthError(null);
    try {
      const displayName = getStoredUser()?.name?.trim();
      await apiFetch('/api/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          ...(displayName ? { name: displayName } : {}),
          // The weekly cap resets at Monday 00:00 in THIS timezone, so send the user's real one.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          address,
          reachKm,
          guiltFreeCapMinor,
          interests,
          socialPref,
          vibePref,
          optInMood,
          optInTracking
        })
      });
      onComplete();
    } catch (err) {
      logError('Onboarding failed:', err);
      setAuthError(err instanceof Error ? err.message : 'Failed to save preferences. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const currentUser = getStoredUser();

  return (
    <div className="max-w-xl mx-auto py-12 px-4 sm:px-6">
      {/* Progress Page Number */}
      <div className="flex justify-between items-center mb-6">
        <span className="font-num text-xs text-taupe uppercase tracking-wider">
          Page {step} of 5
        </span>
        <span className="text-xs font-ui text-taupe">Pocketful Ledger Setup</span>
      </div>

      <div className="bg-parchment border border-oat p-6 sm:p-8 rounded-surface shadow-lift">
        {/* A1: Welcome & Supabase Auth */}
        {step === 1 && (
          <div>
            <div className="flex justify-between items-start mb-4">
              <div className="w-12 h-12 rounded-full bg-burgundy border border-brass flex items-center justify-center shadow-lift">
                <span className="font-display italic text-parchment text-2xl font-bold">p</span>
              </div>
              <Badge type="paypal">PayPal Sandbox</Badge>
            </div>

            <h1 className="font-display text-2xl sm:text-3xl font-semibold text-ink mb-2">
              Make the weekend worth the week.
            </h1>
            <p className="text-sm font-ui text-taupe leading-relaxed mb-6">
              Pocketful connects to your ledger, computes your genuine discretionary cash, finds
              real spots within your reach, and splits the bill cleanly through PayPal.
            </p>

            {authError && (
              <div className="mb-4 p-3 bg-blush border border-burgundy rounded-[2px] text-xs text-burgundy font-ui">
                {authError}
              </div>
            )}

            {/* Auth Switcher */}
            <div className="flex border-b border-oat mb-4">
              <button
                type="button"
                onClick={() => setAuthMode('signin')}
                className={`py-2 px-4 text-xs font-ui font-semibold border-b-2 -mb-[2px] transition-colors ${
                  authMode === 'signin'
                    ? 'border-burgundy text-burgundy'
                    : 'border-transparent text-taupe hover:text-ink'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => setAuthMode('signup')}
                className={`py-2 px-4 text-xs font-ui font-semibold border-b-2 -mb-[2px] transition-colors ${
                  authMode === 'signup'
                    ? 'border-burgundy text-burgundy'
                    : 'border-transparent text-taupe hover:text-ink'
                }`}
              >
                Create Account
              </button>
            </div>

            {authMode === 'signin' ? (
              <form onSubmit={handleSignIn} className="space-y-3 mb-6">
                <div>
                  <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    placeholder="you@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full py-2.5 bg-burgundy text-parchment text-xs font-medium rounded-[2px] hover:bg-claret active:bg-maroon transition-colors shadow-lift"
                >
                  {authLoading ? 'Signing in...' : 'Sign In with Supabase'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleSignUp} className="space-y-3 mb-6">
                <div>
                  <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    placeholder="Your name"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    placeholder="you@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-xs text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full py-2.5 bg-burgundy text-parchment text-xs font-medium rounded-[2px] hover:bg-claret active:bg-maroon transition-colors shadow-lift"
                >
                  {authLoading ? 'Creating account...' : 'Create Account with Supabase'}
                </button>
              </form>
            )}

            <LedgerRule className="my-4" />

            <div className="flex flex-col sm:flex-row justify-between items-center gap-3">
              {demoIdentity && (
                <button
                  type="button"
                  onClick={handleDemoSignIn}
                  className="w-full sm:w-auto px-4 py-2 bg-sand border border-oat text-xs font-ui text-ink rounded-[2px] hover:bg-parchment transition-colors font-medium"
                >
                  1-Click Demo
                </button>
              )}
              {currentUser && (
                <button
                  type="button"
                  onClick={onComplete}
                  className="text-xs text-burgundy underline hover:text-claret font-ui font-medium"
                >
                  Continue as {currentUser.name} →
                </button>
              )}
            </div>
          </div>
        )}

        {/* A2: Home Address */}
        {step === 2 && (
          <div>
            <h2 className="font-display text-xl font-semibold text-ink mb-1">Your home location</h2>
            <p className="text-xs text-taupe mb-4">
              Only you and the planner see this. Pip never receives your exact address.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Home Address or Area
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    className="w-full bg-sand border border-oat rounded-[2px] px-3 py-2 text-sm text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                    placeholder="e.g. Mission District, San Francisco"
                  />
                </div>
                <button
                  type="button"
                  disabled={locating}
                  onClick={handleUseMyLocation}
                  className="text-[11px] text-burgundy underline hover:text-claret font-ui mt-1 inline-block disabled:opacity-50"
                >
                  {locating ? 'Detecting coordinates...' : 'Use my location'}
                </button>
                {locationNotice && (
                  <p className="text-[11px] text-burgundy font-ui mt-1">{locationNotice}</p>
                )}
              </div>

              {matchedCoords && (
                <div className="bg-sand border border-oat p-3 rounded-[2px] text-xs text-taupe flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span>
                    Coordinates matched: {Math.abs(matchedCoords.lat).toFixed(4)}° {matchedCoords.lat >= 0 ? 'N' : 'S'}, {Math.abs(matchedCoords.lng).toFixed(4)}° {matchedCoords.lng >= 0 ? 'E' : 'W'} ({matchedCoords.label})
                  </span>
                  <Badge type="moss">Verified</Badge>
                </div>
              )}
            </div>

            <LedgerRule className="my-6" />
            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-xs text-taupe underline"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => setStep(3)}
                className="px-5 py-1.5 bg-burgundy text-parchment text-sm font-medium rounded-[2px] hover:bg-claret shadow-lift"
              >
                Confirm this is home →
              </button>
            </div>
          </div>
        )}

        {/* A3: Reach and Ceiling */}
        {step === 3 && (
          <div>
            <h2 className="font-display text-xl font-semibold text-ink mb-1">Reach and ceiling</h2>
            <p className="text-xs text-taupe mb-6">
              Deterministic boundaries: the planner will never suggest a venue further than this
              radius or exceeding your guilt-free weekend cap.
            </p>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="font-semibold text-taupe uppercase tracking-wider">
                    Maximum Travel Reach
                  </span>
                  <span className="font-num text-ink font-semibold">{reachKm} km</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="25"
                  value={reachKm}
                  onChange={(e) => setReachKm(Number(e.target.value))}
                  className="w-full accent-burgundy cursor-pointer"
                />
                <span className="text-[11px] text-taupe block mt-1">
                  About 18 verified local spots inside this radius.
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Guilt-Free Weekend Spending Cap
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-taupe font-num">$</span>
                  <input
                    type="number"
                    min="1"
                    value={guiltFreeCapMinor / 100}
                    onChange={(e) => {
                      const val = Math.max(1, Number(e.target.value));
                      setGuiltFreeCapMinor(Math.round(val * 100));
                    }}
                    className="w-full bg-sand border border-oat rounded-[2px] pl-7 pr-3 py-2 text-sm font-num text-ink focus:bg-parchment focus:border-burgundy focus:outline-none"
                  />
                </div>
                <span className="text-[11px] text-taupe block mt-1">
                  Pip guarantees your fixed bills ($1,450.00) and monthly savings ($400.00) remain
                  safe.
                </span>
              </div>
            </div>

            <LedgerRule className="my-6" />
            <div className="flex justify-between">
              <button
                type="button"
                onClick={() => setStep(2)}
                className="text-xs text-taupe underline"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => setStep(4)}
                className="px-5 py-1.5 bg-burgundy text-parchment text-sm font-medium rounded-[2px] hover:bg-claret shadow-lift"
              >
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* A4: Tastes & Vibe Check (F1 priors) */}
        {step === 4 && (
          <div>
            <h2 className="font-display text-xl font-semibold text-ink mb-1">Tastes & Vibe Check</h2>
            <p className="text-xs text-taupe mb-4">
              Optional priors to seed your recommendation bandit. You can also skip and let Pip learn
              purely from your choices.
            </p>
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-2">
                  Interests
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {availableInterests.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => toggleInterest(item.id)}
                      className={`px-3 py-2 text-xs text-left border rounded-[2px] font-ui transition-colors ${
                        interests.includes(item.id)
                          ? 'bg-blush border-burgundy text-burgundy font-medium'
                          : 'bg-sand border-oat text-ink hover:bg-linen'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Vibe Preference Segmented Control */}
              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Vibe Preference
                </label>
                <div className="flex gap-2">
                  {(['quiet', 'lively', 'mixed'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVibePref(v)}
                      className={`flex-1 py-1.5 text-xs capitalize border rounded-[2px] font-ui transition-colors ${
                        vibePref === v
                          ? 'bg-blush border-burgundy text-burgundy font-medium'
                          : 'bg-sand border-oat text-ink'
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Social Preference Segmented Control */}
              <div>
                <label className="block text-xs font-semibold text-taupe uppercase tracking-wider mb-1">
                  Social Preference
                </label>
                <div className="flex gap-2">
                  {(['solo', 'social', 'mixed'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setSocialPref(s)}
                      className={`flex-1 py-1.5 text-xs capitalize border rounded-[2px] font-ui transition-colors ${
                        socialPref === s
                          ? 'bg-blush border-burgundy text-burgundy font-medium'
                          : 'bg-sand border-oat text-ink'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <LedgerRule className="my-6" />
            <div className="flex justify-between items-center">
              <button
                type="button"
                onClick={() => setStep(3)}
                className="text-xs text-taupe underline"
              >
                Back
              </button>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setInterests([]);
                    setStep(5);
                  }}
                  className="text-xs text-taupe underline hover:text-ink"
                >
                  Skip, learn from me
                </button>
                <button
                  type="button"
                  onClick={() => setStep(5)}
                  className="px-5 py-1.5 bg-burgundy text-parchment text-sm font-medium rounded-[2px] hover:bg-claret shadow-lift"
                >
                  Continue →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* A5: Permissions & Connect PayPal */}
        {step === 5 && (
          <div>
            <h2 className="font-display text-xl font-semibold text-ink mb-1">
              Permissions & PayPal
            </h2>
            <p className="text-xs text-taupe mb-6">
              Everything is opt-in and safe. Money actions always require your explicit wax seal
              approval.
            </p>

            {authError && (
              <div className="mb-4 p-3 bg-blush border border-burgundy rounded-[2px] text-xs text-burgundy font-ui">
                {authError}
              </div>
            )}
            <div className="space-y-4">
              <label className="flex items-start gap-3 p-3 bg-sand border border-oat rounded-[2px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={optInTracking}
                  onChange={(e) => setOptInTracking(e.target.checked)}
                  className="accent-burgundy mt-1"
                />
                <div>
                  <span className="text-sm font-semibold text-ink block">Spend Tracking</span>
                  <span className="text-xs text-taupe block">
                    Ingests leisure expenses to learn what you actually enjoy.
                  </span>
                  <span className="text-[11px] text-taupe/80 block mt-0.5">
                    Never touches medical, utility, or private accounts.
                  </span>
                </div>
              </label>

              <label className="flex items-start gap-3 p-3 bg-sand border border-oat rounded-[2px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={optInMood}
                  onChange={(e) => setOptInMood(e.target.checked)}
                  className="accent-burgundy mt-1"
                />
                <div>
                  <span className="text-sm font-semibold text-ink block">Weekly Mood Check-in</span>
                  <span className="text-xs text-taupe block">
                    Gentle 3-stamp check-in (drained, okay, great) that orders suggestions.
                  </span>
                  <span className="text-[11px] text-taupe/80 block mt-0.5">
                    Never lowers or alters your hard budget ceiling.
                  </span>
                </div>
              </label>
            </div>

            <div className="mt-6 p-3 bg-blush border border-burgundy rounded-[2px] text-xs text-burgundy flex items-center justify-between">
              <div>
                <span className="font-semibold block">PayPal Sandbox Connected</span>
                <span className="text-[11px] text-maroon block">
                  Checking balance, subscriptions audit, and verified mock history ready.
                </span>
              </div>
              <Badge type="paypal">Live Sandbox</Badge>
            </div>

            <LedgerRule className="my-6" />
            <div className="flex justify-between items-center">
              <button
                type="button"
                onClick={() => setStep(4)}
                className="text-xs text-taupe underline"
              >
                Back
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={handleFinish}
                className="px-6 py-2 bg-burgundy text-parchment text-sm font-medium rounded-[2px] hover:bg-claret active:bg-maroon transition-colors shadow-lift"
              >
                {loading ? 'Opening Ledger...' : 'Enter the Ledger →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
