// Onboarding.js — 3-step new-user onboarding flow
// Step 1: Profile setup (name, username, activities, dietary, mobility, bio)
// Step 2: Location (required to proceed) + timezone
// Step 3: Notifications (opt-in, never blocks progression)
// Privacy: only boolean/count properties sent to PostHog — no PII, no location string
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import PillInput from '../components/PillInput';
import client from '../utils/client';
import { isAuthenticated, setOnboardingCompleted } from '../utils/auth';

// ── Shared constants (identical to MyProfile.js) ─────────────────────────────
const ACTIVITY_SUGGESTIONS = [
  'coffee','brunch','lunch spots','fine dining','street food',
  'craft beer','wine bars','cocktail bars','rooftop bars','speakeasies',
  'Broadway shows','off-Broadway','comedy clubs','live music','concerts',
  'jazz clubs','art museums','galleries','film screenings',
  'golf','tennis','basketball','pickleball','cycling','running',
  'yoga','rock climbing','boxing',
  'Knicks games','Yankees games','Mets games','Rangers games','Brooklyn Nets','NYCFC',
  'Central Park','hiking','kayaking','beach days','High Line','Governors Island',
  'escape rooms','bowling','arcade bars','board game cafes',
  'cooking classes','bookstores','flea markets','nightlife',
];

const DIETARY_OPTIONS = [
  'vegetarian','vegan','gluten-free','halal','kosher',
  'nut allergy','shellfish allergy','dairy-free','none',
];

const MOBILITY_OPTIONS = [
  'wheelchair accessible required','no stairs','elevator required','none',
];

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
function StepIndicator({ step }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
      {[1, 2, 3].map(s => (
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
        Step {step} of 3
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

  // ── Step 3 state ──────────────────────────────────────────────────────────
  // 'idle' | 'granted' | 'denied'
  const [notifStatus, setNotifStatus] = useState('idle');
  const [completing,  setCompleting]  = useState(false);

  // Pre-fill form from existing profile on mount
  useEffect(() => {
    client.get('/users/me')
      .then(res => {
        const d = res.data;
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
      })
      .catch(() => {}); // silent — fields stay empty, user fills them in
  }, []);

  const setField = f => e => setForm(p => ({ ...p, [f]: e.target.value }));

  const toggleMulti = useCallback((field, value) => {
    setForm(prev => {
      const arr = prev[field];
      return { ...prev, [field]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value] };
    });
  }, []);

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
      setStep(2);
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
      setStep(3);
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
      // Attempt service worker registration — sw.js doesn't exist yet, catch gracefully
      try {
        await navigator.serviceWorker.register('/sw.js');
        // TODO: store push subscription in push_subscriptions table
        // when web push infrastructure sprint is complete
      } catch { /* expected — sw.js not built yet */ }
      // Brief pause so the user sees the success state before navigating away
      setTimeout(() => completeOnboarding(true), 1200);
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

  // ── Step 1 render ─────────────────────────────────────────────────────────
  if (step === 1) return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} />
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
              onClick={() => setStep(2)}
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

  // ── Step 2 render ─────────────────────────────────────────────────────────
  if (step === 2) return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} />
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

  // ── Step 3 render ─────────────────────────────────────────────────────────
  return (
    <main className="page">
      <div className="container container--sm" style={{ paddingBottom: 40, paddingTop: 32 }}>
        <StepIndicator step={step} />
        <h1 className="page-title">Stay in the loop</h1>
        <p className="page-subtitle" style={{ marginBottom: 28 }}>
          We'll only notify you when a friend invites you to a plan or your plan locks in.
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
            You're all set! Taking you home…
          </div>
        )}

        {notifStatus === 'denied' && (
          <>
            <div style={{ padding: '12px 0', color: 'var(--text-2)', fontSize: '0.9rem', textAlign: 'center' }}>
              No worries — you can enable them later in your browser settings.
            </div>
            <button
              className="btn btn--primary btn--lg"
              onClick={() => completeOnboarding(false)}
              disabled={completing}
              style={{ width: '100%' }}
            >
              {completing ? 'Finishing up…' : 'Continue anyway'}
            </button>
          </>
        )}
      </div>
    </main>
  );
}
