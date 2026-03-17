// Onboarding.js — Platform-aware onboarding flow
// Step order varies by platform (see detectPlatform). Push is skipped on iOS
// Safari browser (useless without PWA); an "Add to Home Screen" step is
// injected instead. Android Chrome gets both push + A2HS (5 steps).
//
// Resume: on mount the furthest-incomplete step is detected from /users/me so
// users who dropped off don't re-enter saved data.
//
// Privacy: only boolean/count properties sent to PostHog — no PII, no location string
//
// TODO [username-availability]: Add async username availability check on blur
// in Step 1 — debounced GET /users/check-username?username=foo, show inline
// error if taken. Needs a new server route.
// TODO [step-transitions]: Add CSS fade/slide transition between steps for a
// less abrupt step change. Client-only polish pass.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import PillInput from '../components/PillInput';
import client from '../utils/client';
import { isAuthenticated, setOnboardingCompleted } from '../utils/auth';
import { messaging, getToken } from '../firebase';
import {
  registerPushToken,
  getCalendarConnections,
  getGoogleConnectUrl,
  setPrimaryCalendarConnection,
  removeCalendarConnection,
  connectAppleCalendar,
} from '../utils/api';
import { ACTIVITY_SUGGESTIONS, DIETARY_OPTIONS, MOBILITY_OPTIONS } from '../utils/profileOptions';

// ── Platform detection ──────────────────────────────────────────────────────
// Called once on mount; result stored in a ref (never changes mid-session).
function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) {
    if (window.navigator.standalone) return 'ios-pwa';
    if (/safari/i.test(ua) && !/chrome|crios|fxios/i.test(ua)) return 'ios-safari-browser';
  }
  if (/android/i.test(ua) && /chrome/i.test(ua) && !/edg/i.test(ua)) return 'android-chrome';
  return 'other';
}

// ── Step sequences by platform ──────────────────────────────────────────────
// Each value is an ordered list of logical step keys.
const STEP_SEQUENCES = {
  'ios-safari-browser': ['profile', 'location', 'a2hs', 'calendar'],
  'ios-pwa':            ['profile', 'location', 'push', 'calendar'],
  'android-chrome':     ['profile', 'location', 'push', 'a2hs', 'calendar'],
  'other':              ['profile', 'location', 'push', 'calendar'],
};

const TIMEZONES = [
  { label: '─── United States ───', value: '', disabled: true },
  { label: 'Eastern Time (ET)',  value: 'America/New_York' },
  { label: 'Central Time (CT)',  value: 'America/Chicago' },
  { label: 'Mountain Time (MT)', value: 'America/Denver' },
  { label: 'Pacific Time (PT)',  value: 'America/Los_Angeles' },
  { label: 'Arizona (no DST)',   value: 'America/Phoenix' },
  { label: 'Alaska (AKT)',       value: 'America/Anchorage' },
  { label: 'Hawaii (HST)',       value: 'America/Honolulu' },
  { label: '─── North America ───', value: '', disabled: true },
  { label: 'Toronto (ET)',       value: 'America/Toronto' },
  { label: 'Vancouver (PT)',     value: 'America/Vancouver' },
  { label: 'Mexico City (CT)',   value: 'America/Mexico_City' },
  { label: '─── Europe ───',     value: '', disabled: true },
  { label: 'London (GMT/BST)',   value: 'Europe/London' },
  { label: 'Paris (CET)',        value: 'Europe/Paris' },
  { label: 'Berlin (CET)',       value: 'Europe/Berlin' },
  { label: '─── Asia & Pacific ───', value: '', disabled: true },
  { label: 'India (IST)',        value: 'Asia/Kolkata' },
  { label: 'Tokyo (JST)',        value: 'Asia/Tokyo' },
  { label: 'Sydney (AEDT)',      value: 'Australia/Sydney' },
];

function validateUsername(v) {
  if (!v) return 'Username is required.';
  if (/\s/.test(v)) return 'No spaces allowed.';
  if (!/^[a-z0-9._-]+$/.test(v)) return 'Lowercase letters, numbers, . _ - only.';
  if (v.length < 3) return 'At least 3 characters.';
  if (v.length > 30) return 'Max 30 characters.';
  return '';
}

// ── Step indicator ────────────────────────────────────────────────────────────
function StepIndicator({ step, totalSteps = 4 }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
      {Array.from({ length: totalSteps }, (_, i) => i + 1).map(s => (
        <div
          key={s}
          style={{
            width: s === step ? 24 : 8,
            height: 8,
            borderRadius: 4,
            background: s === step
              ? 'var(--brand)'
              : s < step
                ? 'var(--brand-light, #c7d2fe)'
                : 'var(--border)',
            transition: 'all 0.2s',
          }}
        />
      ))}
      <span style={{ fontSize: '0.78rem', color: 'var(--text-3)', marginLeft: 4 }}>
        Step {step} of {totalSteps}
      </span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Onboarding() {
  const navigate = useNavigate();

  // Redirect to login if not authenticated — this route is not wrapped in ProtectedRoute
  useEffect(() => {
    if (!isAuthenticated()) navigate('/', { replace: true });
  }, [navigate]);

  // Platform detection — stable for the session
  const platformRef = useRef(detectPlatform());
  const platform = platformRef.current;
  const stepSequence = STEP_SEQUENCES[platform];
  const totalSteps = stepSequence.length;

  // Map from visual step number (1-based) to logical step key
  const stepKeyAt = (n) => stepSequence[n - 1];
  // Map from logical key to visual step number
  const stepNumberFor = (key) => stepSequence.indexOf(key) + 1;

  const [step, setStep] = useState(1);

  // ── Step 1 state ──────────────────────────────────────────────────────────
  const [form, setForm] = useState({
    full_name: '', username: '', bio: '',
    activities: [], dietary: [], mobility: [],
  });
  const [usernameError, setUsernameError] = useState('');
  const [saving,        setSaving]        = useState(false);
  const [saveErr,       setSaveErr]       = useState('');

  // ── Step 2 state ──────────────────────────────────────────────────────────
  const [location,         setLocation]         = useState('');
  const [timezone,         setTimezone]         = useState('');
  const [locating,         setLocating]         = useState(false);
  const [locError,         setLocError]         = useState('');
  const [locSuccess,       setLocSuccess]       = useState('');
  const [locationRequired, setLocationRequired] = useState('');
  const [savingLoc,        setSavingLoc]        = useState(false);
  const [saveLocErr,       setSaveLocErr]       = useState('');

  // ── Push step state ───────────────────────────────────────────────────────
  // 'idle' | 'granted' | 'denied'
  const [notifStatus,  setNotifStatus]  = useState('idle');
  const [notifGranted, setNotifGranted] = useState(false);
  const [completing,   setCompleting]   = useState(false);

  // ── A2HS step state ───────────────────────────────────────────────────────
  const deferredPromptRef = useRef(null);
  const [a2hsPromptReady, setA2hsPromptReady] = useState(false);

  // ── Calendar step state ───────────────────────────────────────────────────
  const [connections,        setConnections]        = useState([]);
  const [connectionLoading,  setConnectionLoading]  = useState(null);
  const [connectionError,    setConnectionError]    = useState('');
  const [confirmingRemoveId, setConfirmingRemoveId] = useState(null);
  const [appleGuideOpen,     setAppleGuideOpen]     = useState(false);
  const [appleEmail,         setAppleEmail]         = useState('');
  const [applePassword,      setApplePassword]      = useState('');
  const [appleSubmitting,    setAppleSubmitting]    = useState(false);
  const [appleMessage,       setAppleMessage]       = useState('');
  const [appleIsError,       setAppleIsError]       = useState(false);

  // Listen for Android beforeinstallprompt
  useEffect(() => {
    if (platform !== 'android-chrome') return;
    function handler(e) {
      e.preventDefault();
      deferredPromptRef.current = e;
      setA2hsPromptReady(true);
    }
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [platform]);

  // Pre-fill form from existing profile + resume from last incomplete step
  useEffect(() => {
    client.get('/users/me')
      .then(res => {
        const d = res.data;

        // If onboarding already completed, go straight to home
        if (d.onboarding_completed_at) {
          navigate('/home', { replace: true });
          return;
        }

        setForm({
          full_name:  d.full_name  || '',
          username:   d.username   || '',
          bio:        d.bio        || '',
          activities: d.activity_preferences  || [],
          dietary:    d.dietary_restrictions  || [],
          mobility:   d.mobility_restrictions || [],
        });
        setLocation(d.location  || '');
        setTimezone(d.timezone  || '');

        // Item 4: auto-detect timezone if not already set
        if (!d.timezone) {
          try {
            const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (detected) setTimezone(detected);
          } catch { /* silent */ }
        }

        // Item 2: resume from furthest incomplete step
        if (d.location && d.location.trim()) {
          // Location done → jump to first step after location (push or a2hs)
          setStep(3);
        }
        // Otherwise start at step 1
      })
      .catch(() => {
        // silent — fields stay empty, user fills them in
        // Still auto-detect timezone
        try {
          const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (detected) setTimezone(detected);
        } catch { /* silent */ }
      });
  }, [navigate]);

  // Load calendar connections when the calendar step is reached
  const calendarStepNum = stepNumberFor('calendar');
  useEffect(() => {
    if (step !== calendarStepNum) return;
    getCalendarConnections()
      .then(data => setConnections(data.connections || []))
      .catch(() => {}); // fail silently — step renders regardless
  }, [step, calendarStepNum]);

  // Dismiss the two-click remove confirmation when the user clicks outside
  useEffect(() => {
    if (!confirmingRemoveId) return;
    function handleMouseDown(e) {
      if (!e.target.closest('[data-remove-btn]')) setConfirmingRemoveId(null);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [confirmingRemoveId]);

  const setField = f => e => setForm(p => ({ ...p, [f]: e.target.value }));

  const toggleMulti = useCallback((field, value) => {
    setForm(prev => {
      const arr = prev[field];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value] };
    });
  }, []);

  // Helper: advance to the next logical step
  const advanceFrom = (currentStep) => setStep(currentStep + 1);

  // ── Step 1: save and advance ──────────────────────────────────────────────
  async function handleStep1Continue(e) {
    e.preventDefault();
    const err = validateUsername(form.username);
    if (err) { setUsernameError(err); return; }
    setSaving(true);
    setSaveErr('');
    try {
      await client.post('/users/profile', {
        full_name:  form.full_name,
        username:   form.username,
        bio:        form.bio,
        activities: form.activities,
        dietary:    form.dietary,
        mobility:   form.mobility,
        // Carry through location/timezone so step 1 save doesn't wipe them
        location,
        timezone,
      });
      advanceFrom(step);
    } catch (err) {
      setSaveErr(err.response?.data?.error || err.message || 'Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Step 2: geolocation ───────────────────────────────────────────────────
  async function handleUseLocation() {
    if (!navigator.geolocation) {
      setLocError('Geolocation is not supported by your browser.');
      return;
    }
    setLocating(true);
    setLocError('');
    setLocSuccess('');
    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const res = await client.get('/geocode', {
            params: { lat: coords.latitude, lng: coords.longitude },
          });
          const resolved = res.data.location || '';
          setLocation(resolved);
          if (resolved) setLocSuccess(resolved);
        } catch {
          setLocError('Could not determine your location. Enter it manually.');
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocError('Location access denied. Enter your location manually.');
        setLocating(false);
      }
    );
  }

  // ── Step 2: save location and advance ────────────────────────────────────
  // Uses PATCH /users/location so this works even if the user skipped step 1
  // and doesn't yet have a username (POST /users/profile requires username).
  async function handleStep2Continue(e) {
    e.preventDefault();
    if (!location.trim()) {
      setLocationRequired('Location is required so we can suggest nearby venues.');
      return;
    }
    setLocationRequired('');
    setSavingLoc(true);
    setSaveLocErr('');
    try {
      await client.patch('/users/location', { location: location.trim(), timezone });
      advanceFrom(step);
    } catch (err) {
      setSaveLocErr(err.response?.data?.error || err.message || 'Could not save. Try again.');
    } finally {
      setSavingLoc(false);
    }
  }

  // ── Step 3: notification permission ──────────────────────────────────────
  async function handleEnableNotifications() {
    if (!('Notification' in window)) {
      setNotifStatus('denied');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setNotifStatus('granted');
      try {
        const token = await getToken(messaging, {
          vapidKey: process.env.REACT_APP_FIREBASE_VAPID_KEY,
          serviceWorkerRegistration: await navigator.serviceWorker.register(
            '/firebase-messaging-sw.js'
          ),
        });
        if (token) {
          await registerPushToken(token);
        }
      } catch (err) {
        // Non-fatal: push token registration failure should never block onboarding
        console.warn('[push] token registration failed:', err.message);
      }
      // Brief pause so the user sees the success state before advancing
      const pushStepNum = stepNumberFor('push');
      setTimeout(() => { setNotifGranted(true); advanceFrom(pushStepNum); }, 1200);
    } else {
      setNotifStatus('denied');
    }
  }

  async function completeOnboarding(notificationGranted) {
    setCompleting(true);
    try {
      await client.patch('/users/onboarding-complete');
      setOnboardingCompleted(true);
      // Privacy: only boolean/count properties — no PII, no location string
      try {
        posthog.capture('onboarding_completed', {
          location_granted:     !!location.trim(),
          notification_granted: notificationGranted,
          preferences_count:    form.activities.length,
        });
      } catch {}
    } catch { /* best-effort — navigate regardless */ }
    navigate('/home', { replace: true });
  }

  // ── Step 4: calendar connection handlers ─────────────────────────────────
  const refetchConnections = useCallback(() =>
    getCalendarConnections()
      .then(data => setConnections(data.connections || []))
      .catch(err => { console.error('[refetchConnections] failed:', err); }),
  []);

  function showConnectionError(msg) {
    setConnectionError(msg);
    setTimeout(() => setConnectionError(''), 4000);
  }

  async function handleSetPrimary(id) {
    setConnectionLoading(id);
    setConfirmingRemoveId(null);
    try {
      await setPrimaryCalendarConnection(id);
      await refetchConnections();
    } catch (err) {
      showConnectionError(err.message || 'Could not update primary calendar.');
    } finally {
      setConnectionLoading(null);
    }
  }

  async function handleRemove(id) {
    if (confirmingRemoveId !== id) {
      setConfirmingRemoveId(id);
      return;
    }
    setConnectionLoading(id);
    setConfirmingRemoveId(null);
    try {
      await removeCalendarConnection(id);
      await refetchConnections();
    } catch (err) {
      showConnectionError(err.message || 'Could not remove calendar.');
    } finally {
      setConnectionLoading(null);
    }
  }

  async function handleAppleSubmit(e) {
    if (e?.preventDefault) e.preventDefault();
    setAppleSubmitting(true);
    setAppleMessage('');
    setAppleIsError(false);
    try {
      await connectAppleCalendar({ email: appleEmail, password: applePassword });
      setAppleMessage('Apple Calendar connected! It now appears in your Connected Calendars list.');
      setAppleIsError(false);
      setAppleEmail('');
      setApplePassword('');
      await refetchConnections();
    } catch (err) {
      setAppleIsError(true);
      const serverMsg = err.message || '';
      if (err.status === 501) {
        setAppleMessage('Apple Calendar support is coming soon.');
      } else if (serverMsg.includes('already connected')) {
        setAppleMessage('This Apple account is already connected — you can see it in the Connected Calendars list above.');
      } else if (serverMsg && serverMsg !== 'Something went wrong. Please try again.') {
        setAppleMessage(serverMsg);
      } else {
        setAppleMessage(
          'Connection failed. Make sure you\'re using your iCloud email (not a Gmail or other address) ' +
          'and an app-specific password from appleid.apple.com — not your regular Apple ID password.'
        );
      }
    } finally {
      setAppleSubmitting(false);
    }
  }

  // ── Current logical step key ──────────────────────────────────────────────
  const currentKey = stepKeyAt(step);

  // ── A2HS auto-advance ────────────────────────────────────────────────────
  // Must be placed before any early returns so hooks are called unconditionally.
  const a2hsShouldAutoAdvance = currentKey === 'a2hs' && (
    (platform === 'android-chrome' && !a2hsPromptReady) ||
    (platform === 'ios-safari-browser' && !!localStorage.getItem('rendezvous_a2hs_dismissed'))
  );
  useEffect(() => {
    if (!a2hsShouldAutoAdvance) return;
    localStorage.setItem('rendezvous_a2hs_dismissed', '1');
    advanceFrom(step);
  }, [a2hsShouldAutoAdvance, step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (a2hsShouldAutoAdvance) return null;

  // ── Step 1 render (profile) ─────────────────────────────────────────────
  if (currentKey === 'profile') return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} totalSteps={totalSteps} />
        <h1 className="page-title">Tell us about yourself</h1>
        <p className="page-subtitle" style={{ marginBottom: 28 }}>
          This helps us suggest the right places and activities.
        </p>

        {saveErr && <div className="alert alert--error" style={{ marginBottom: 16 }}>{saveErr}</div>}

        <form onSubmit={handleStep1Continue} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="ob_full_name">Full name</label>
            <input
              id="ob_full_name"
              type="text"
              className="form-control"
              value={form.full_name}
              onChange={setField('full_name')}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ob_username">Username</label>
            <input
              id="ob_username"
              type="text"
              className={`form-control${usernameError ? ' form-control--error' : ''}`}
              value={form.username}
              onChange={e => setForm(p => ({ ...p, username: e.target.value.toLowerCase().replace(/\s/g, '') }))}
              onBlur={() => setUsernameError(validateUsername(form.username))}
              spellCheck="false"
              required
            />
            {usernameError
              ? <p className="form-error">{usernameError}</p>
              : <p className="form-hint">Lowercase, no spaces. Others find you by this.</p>}
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ob_bio">Bio <span className="optional">optional</span></label>
            <textarea id="ob_bio" className="form-control" value={form.bio} onChange={setField('bio')} rows={3} />
          </div>

          <div className="form-group">
            <label className="form-label">Activity preferences <span className="optional">optional</span></label>
            <PillInput
              pills={form.activities}
              onChange={activities => setForm(p => ({ ...p, activities }))}
              suggestions={ACTIVITY_SUGGESTIONS}
              placeholder="e.g. rooftop bars, board games…"
              suggestionsLabel="Popular interests"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Dietary restrictions <span className="optional">optional</span></label>
            <div className="checkbox-group">
              {DIETARY_OPTIONS.map(opt => (
                <label key={opt} className={`checkbox-item${form.dietary.includes(opt) ? ' checkbox-item--checked' : ''}`}>
                  <input type="checkbox" checked={form.dietary.includes(opt)} onChange={() => toggleMulti('dietary', opt)} />
                  {opt}
                </label>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Mobility &amp; accessibility <span className="optional">optional</span></label>
            <div className="checkbox-group">
              {MOBILITY_OPTIONS.map(opt => (
                <label key={opt} className={`checkbox-item${form.mobility.includes(opt) ? ' checkbox-item--checked' : ''}`}>
                  <input type="checkbox" checked={form.mobility.includes(opt)} onChange={() => toggleMulti('mobility', opt)} />
                  {opt}
                </label>
              ))}
            </div>
            <p className="form-hint" style={{ marginTop: 8 }}>
              These preferences may be shared with an AI model to generate personalized activity suggestions.
            </p>
          </div>

          <div style={{ marginTop: 24 }}>
            <button
              type="submit"
              className="btn btn--primary btn--lg"
              disabled={saving}
              style={{ width: '100%' }}
            >
              {saving ? 'Saving…' : 'Continue'}
            </button>
            <button
              type="button"
              onClick={() => advanceFrom(step)}
              style={{
                display: 'block', margin: '14px auto 0',
                background: 'none', border: 'none',
                color: 'var(--text-3)', fontSize: '0.88rem', cursor: 'pointer',
              }}
            >
              Skip for now
            </button>
          </div>
        </form>
      </div>
    </main>
  );

  // ── Step 2 render (location) ──────────────────────────────────────────────
  if (currentKey === 'location') return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} totalSteps={totalSteps} />
        <h1 className="page-title">Where are you based?</h1>
        <p className="page-subtitle" style={{ marginBottom: 28 }}>
          Used only to suggest nearby venues. Never shared with other users.
        </p>

        {saveLocErr && <div className="alert alert--error" style={{ marginBottom: 16 }}>{saveLocErr}</div>}

        <form onSubmit={handleStep2Continue} noValidate>
          <div className="form-group">
            <label className="form-label" htmlFor="ob_location">Location</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="ob_location"
                type="text"
                className="form-control"
                value={location}
                onChange={e => {
                  setLocError('');
                  setLocSuccess('');
                  setLocationRequired('');
                  setLocation(e.target.value);
                }}
                placeholder="City or neighborhood"
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={handleUseLocation}
                disabled={locating}
                style={{ whiteSpace: 'nowrap' }}
              >
                {locating ? '…' : '📍 Use my location'}
              </button>
            </div>
            {locationRequired && <div className="form-error" style={{ marginTop: 4 }}>{locationRequired}</div>}
            {locError         && <div className="form-error" style={{ marginTop: 4 }}>{locError}</div>}
            {locSuccess       && <div className="alert alert--success" style={{ marginTop: 4 }}>Location set to: {locSuccess}</div>}
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="ob_timezone">Timezone</label>
            <select
              id="ob_timezone"
              className="form-control"
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
            >
              <option value="">Select…</option>
              {TIMEZONES.map((tz, i) => tz.disabled
                ? <option key={i} value="" disabled>{tz.label}</option>
                : <option key={tz.value} value={tz.value}>{tz.label}</option>
              )}
            </select>
          </div>

          <div style={{ marginTop: 24 }}>
            <button
              type="submit"
              className="btn btn--primary btn--lg"
              disabled={savingLoc}
              style={{ width: '100%' }}
            >
              {savingLoc ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </form>
      </div>
    </main>
  );

  // ── A2HS render ──────────────────────────────────────────────────────────
  if (currentKey === 'a2hs') {

    const handleA2hsAdvance = () => {
      localStorage.setItem('rendezvous_a2hs_dismissed', '1');
      advanceFrom(step);
    };

    const handleAndroidInstall = async () => {
      if (deferredPromptRef.current) {
        deferredPromptRef.current.prompt();
        await deferredPromptRef.current.userChoice;
      }
      handleA2hsAdvance();
    };

    if (platform === 'android-chrome') {
      return (
        <main className="page">
          <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
            <StepIndicator step={step} totalSteps={totalSteps} />
            <h1 className="page-title">Add Rendezvous to your home screen</h1>
            <p className="page-subtitle" style={{ marginBottom: 28 }}>
              For quick access, add Rendezvous to your home screen.
            </p>
            <button
              className="btn btn--primary btn--lg"
              onClick={handleAndroidInstall}
              style={{ width: '100%' }}
            >
              Add to home screen
            </button>
            <button
              type="button"
              onClick={handleA2hsAdvance}
              style={{
                display: 'block', margin: '14px auto 0',
                background: 'none', border: 'none',
                color: 'var(--text-3)', fontSize: '0.88rem', cursor: 'pointer',
              }}
            >
              Skip
            </button>
          </div>
        </main>
      );
    }

    // ios-safari-browser
    return (
      <main className="page">
        <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
          <StepIndicator step={step} totalSteps={totalSteps} />
          <h1 className="page-title">Add Rendezvous to your home screen</h1>
          <p className="page-subtitle" style={{ marginBottom: 28 }}>
            For the best experience — and to receive notifications — install Rendezvous on your home screen.
          </p>
          <div
            className="card"
            style={{
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '16px 20px',
              marginBottom: 24,
              fontSize: '0.92rem',
              color: 'var(--text-2)',
              lineHeight: 1.6,
            }}
          >
            Tap the share icon (□↑) at the bottom of Safari, then tap <strong>"Add to Home Screen"</strong>.
          </div>
          <button
            className="btn btn--primary btn--lg"
            onClick={handleA2hsAdvance}
            style={{ width: '100%' }}
          >
            I've added it
          </button>
          <button
            type="button"
            onClick={handleA2hsAdvance}
            style={{
              display: 'block', margin: '14px auto 0',
              background: 'none', border: 'none',
              color: 'var(--text-3)', fontSize: '0.88rem', cursor: 'pointer',
            }}
          >
            Skip for now
          </button>
        </div>
      </main>
    );
  }

  // ── Push enablement render ──────────────────────────────────────────────
  if (currentKey === 'push') return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} totalSteps={totalSteps} />
        <h1 className="page-title">Stay in the loop</h1>
        <p className="page-subtitle" style={{ marginBottom: 28 }}>
          Get notified when a friend invites you to a plan or your plans lock in. Most users enable this — you'll miss real-time updates without it.
        </p>

        <div className="card card-pad" style={{ marginBottom: 24 }}>
          <p style={{ margin: '0 0 8px', fontSize: '0.92rem', color: 'var(--text-2)' }}>
            Notifications let you know when:
          </p>
          <ul style={{ margin: '0 0 4px', paddingLeft: 20, color: 'var(--text-2)', fontSize: '0.92rem', lineHeight: 1.8 }}>
            <li>A friend invites you to a plan</li>
            <li>Your plan is confirmed and locked in</li>
            <li>Your friend accepts or suggests an alternative</li>
          </ul>
          <p className="form-hint" style={{ marginTop: 12 }}>
            Privacy: Only used for itinerary updates and friend activity.
          </p>
        </div>

        {notifStatus === 'idle' && (
          <button
            className="btn btn--primary btn--lg"
            onClick={handleEnableNotifications}
            style={{ width: '100%' }}
          >
            Enable notifications
          </button>
        )}

        {notifStatus === 'granted' && (
          <div className="alert alert--success" style={{ textAlign: 'center', padding: '16px' }}>
            You're all set! One more step…
          </div>
        )}

        {notifStatus === 'denied' && (
          <>
            <div style={{ padding: '12px 0', color: 'var(--text-2)', fontSize: '0.9rem', textAlign: 'center' }}>
              You can enable notifications later in Settings → Notifications.
            </div>
            <button
              className="btn btn--primary btn--lg"
              onClick={() => advanceFrom(step)}
              style={{ width: '100%' }}
            >
              Continue anyway
            </button>
          </>
        )}
      </div>
    </main>
  );

  // ── Calendar step render ─────────────────────────────────────────────────
  // Item 3: show connected Google email in subtitle
  const loginConnection = connections.find(c => c.is_login_account) || connections.find(c => c.is_primary);
  const calendarSubtitle = loginConnection?.account_email
    ? `Your Google Calendar is connected as ${loginConnection.account_email}. Add a work calendar, Apple Calendar, or another Google account to make sure your availability is always accurate.`
    : 'Your Google Calendar is already connected. Add a work calendar, Apple Calendar, or another Google account to make sure your availability is always accurate.';

  const calendarCard = (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div className="form-section-title" style={{ marginBottom: 0 }}>Connected Calendars</div>
        <a href={getGoogleConnectUrl()} className="btn btn--secondary btn--sm">Add Google Calendar</a>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {connections.map(conn => {
          const isLoading    = connectionLoading === conn.id;
          const isConfirming = confirmingRemoveId === conn.id;
          const anyLoading   = !!connectionLoading;
          return (
            <li key={conn.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 10, flexWrap: 'wrap' }}>
              <span className="badge badge--gray">{conn.provider}</span>
              <span style={{ flex: 1 }}>{conn.account_email || conn.account_label}</span>
              {conn.is_primary && (
                <span className="badge badge--green">{conn.is_login_account ? 'Login account' : 'Primary'}</span>
              )}
              {!conn.is_primary && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => handleSetPrimary(conn.id)}
                  disabled={isLoading || anyLoading}
                >
                  {isLoading ? '…' : 'Set as primary'}
                </button>
              )}
              {!conn.is_login_account && (
                <button
                  type="button"
                  data-remove-btn="true"
                  className={`btn btn--sm ${isConfirming ? 'btn--danger' : 'btn--ghost'}`}
                  onClick={() => handleRemove(conn.id)}
                  disabled={isLoading || anyLoading}
                >
                  {isLoading ? '…' : isConfirming ? 'Confirm remove' : 'Remove'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {connectionError && (
        <div className="alert alert--error" style={{ marginTop: 10, marginBottom: 0 }}>{connectionError}</div>
      )}

      {/* ── Apple CalDAV setup guide ── */}
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setAppleGuideOpen(o => !o)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ fontSize: 11 }}>{appleGuideOpen ? '▼' : '▶'}</span>
          Connect Apple Calendar
        </button>
        {appleGuideOpen && (
          <div style={{ marginTop: 12 }}>
            <div className="form-section-title" style={{ marginBottom: 4 }}>Connect Apple Calendar</div>
            <p className="form-hint" style={{ marginBottom: 12 }}>Apple Calendar uses app-specific passwords for third-party access.</p>
            <ol style={{ paddingLeft: 18, margin: '0 0 14px 0', fontSize: 14, lineHeight: 1.7 }}>
              <li>Go to <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer">appleid.apple.com</a> and sign in</li>
              <li>Under <strong>Security</strong>, tap <strong>App-Specific Passwords</strong> → <strong>Generate Password</strong></li>
              <li>Label it <strong>Rendezvous</strong> and tap Create</li>
              <li>Copy the 16-character password shown — you won't see it again</li>
              <li>Enter your iCloud email and paste the password below</li>
            </ol>
            <div>
              <div className="form-group" style={{ marginBottom: 10 }}>
                <input
                  type="email"
                  className="form-control"
                  placeholder="your@icloud.com"
                  value={appleEmail}
                  onChange={e => setAppleEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group" style={{ marginBottom: 10 }}>
                <input
                  type="password"
                  className="form-control"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={applePassword}
                  onChange={e => setApplePassword(e.target.value)}
                  required
                />
              </div>
              {appleMessage && (
                <div className={`alert alert--${appleIsError ? 'error' : 'success'}`} style={{ marginBottom: 10 }}>{appleMessage}</div>
              )}
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={handleAppleSubmit}
                disabled={appleSubmitting || !appleEmail || !applePassword}
              >
                {appleSubmitting ? 'Connecting…' : 'Connect Apple Calendar'}
              </button>
            </div>
            <p className="form-hint" style={{ marginTop: 10, marginBottom: 6 }}>
              This password only grants calendar access. You can revoke it anytime at{' '}
              <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer">
                appleid.apple.com → Security → App-Specific Passwords
              </a>.
            </p>
            <a href="https://appleid.apple.com" target="_blank" rel="noopener noreferrer" style={{ fontSize: 14 }}>
              Open Apple ID settings →
            </a>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} totalSteps={totalSteps} />
        <h1 className="page-title">Your calendars</h1>
        <p className="page-subtitle" style={{ marginBottom: 28 }}>
          {calendarSubtitle}
        </p>

        {calendarCard}

        <button
          type="button"
          className="btn btn--primary btn--lg"
          onClick={() => completeOnboarding(notifGranted)}
          disabled={completing}
          style={{ width: '100%' }}
        >
          {completing ? 'Finishing up…' : 'Done'}
        </button>
        <button
          type="button"
          onClick={() => completeOnboarding(notifGranted)}
          disabled={completing}
          style={{
            display: 'block', margin: '14px auto 0',
            background: 'none', border: 'none',
            color: 'var(--text-3)', fontSize: '0.88rem', cursor: 'pointer',
          }}
        >
          Skip for now
        </button>
      </div>
    </main>
  );
}
