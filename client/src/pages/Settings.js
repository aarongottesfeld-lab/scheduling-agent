// Settings.js — appearance, notification preferences, and privacy controls
import React, { useEffect, useState, useCallback } from 'react';
import NavBar from '../components/NavBar';
import client from '../utils/client';
import useTheme from '../utils/useTheme';
import { messaging, getToken } from '../firebase';
import { registerPushToken } from '../utils/api';

// ── Notification type definitions ────────────────────────────────────────────
const NOTIFICATION_GROUPS = [
  {
    label: 'Friends',
    types: [
      { key: 'friend_request',          label: 'Friend requests' },
      { key: 'friend_request_accepted', label: 'Request accepted' },
    ],
  },
  {
    label: 'Plans',
    types: [
      { key: 'itinerary_invite',   label: 'Plan invitations' },
      { key: 'itinerary_accepted', label: 'Plan accepted' },
      { key: 'itinerary_declined', label: 'Plan declined' },
      { key: 'itinerary_reroll',   label: 'Rerolled by friend' },
      { key: 'itinerary_locked',   label: 'Plan locked in' },
    ],
  },
  {
    label: 'Groups',
    types: [
      { key: 'group_invite',                label: 'Group invitations' },
      { key: 'group_event_invite',          label: 'Group event invites' },
      { key: 'group_event_counter_proposal', label: 'Counter proposals' },
    ],
  },
];

function getChannel(settings, typeKey, channel) {
  return settings[typeKey]?.[channel] ?? true;
}

export default function Settings() {
  const [theme, setTheme] = useTheme();
  const [loading, setLoading]   = useState(true);
  const [settings, setSettings] = useState({});
  const [privacy, setPrivacy]   = useState(true);
  const [saved, setSaved]       = useState(false);
  const [permissionState, setPermissionState] = useState('unsupported');

  // iOS non-standalone detection
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone === true;
  const isIOSNonPWA = isIOS && !isStandalone;

  // Detect push permission state
  useEffect(() => {
    if (isIOSNonPWA) {
      setPermissionState('ios_non_pwa');
    } else if (!('Notification' in window)) {
      setPermissionState('unsupported');
    } else {
      setPermissionState(Notification.permission);
    }
  }, [isIOSNonPWA]);

  // Load settings on mount
  useEffect(() => {
    client.get('/users/settings')
      .then(res => {
        setSettings(res.data.notification_settings || {});
        setPrivacy(res.data.allow_non_friend_group_invites ?? true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const flashSaved = useCallback(() => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  // Persist settings to server
  const patchSettings = useCallback(async (notifSettings, privacyValue) => {
    try {
      await client.patch('/users/settings', {
        notification_settings: notifSettings,
        allow_non_friend_group_invites: privacyValue,
      });
      flashSaved();
    } catch (err) {
      console.error('[settings] save failed:', err.message);
    }
  }, [flashSaved]);

  function toggleChannel(typeKey, channel) {
    setSettings(prev => {
      const current = prev[typeKey]?.[channel] ?? true;
      const newVal = !current;
      const entry = { ...(prev[typeKey] || {}), [channel]: newVal };

      // If both channels are true, remove the key entirely (default = both on)
      const inProduct = channel === 'in_product' ? newVal : (entry.in_product ?? true);
      const push = channel === 'push' ? newVal : (entry.push ?? true);

      let next;
      if (inProduct && push) {
        next = { ...prev };
        delete next[typeKey];
      } else {
        next = { ...prev, [typeKey]: entry };
      }

      patchSettings(next, privacy);
      return next;
    });
  }

  function togglePrivacy() {
    setPrivacy(prev => {
      const next = !prev;
      patchSettings(settings, next);
      return next;
    });
  }

  async function handleEnablePush() {
    try {
      const permission = await Notification.requestPermission();
      setPermissionState(permission);
      if (permission === 'granted') {
        const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
        const token = await getToken(messaging, {
          vapidKey: process.env.REACT_APP_FIREBASE_VAPID_KEY,
          serviceWorkerRegistration: registration,
        });
        if (token) await registerPushToken(token);
      }
    } catch (err) {
      console.warn('[push] enable failed:', err.message);
    }
  }

  const pushDisabled = permissionState !== 'granted' && permissionState !== 'ios_non_pwa';

  // ── Toggle pill component ──────────────────────────────────────────────────
  const Toggle = ({ on, onClick, disabled }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 40,
        height: 22,
        borderRadius: 'var(--r-pill)',
        border: on ? 'none' : '1px solid var(--border)',
        background: on ? 'var(--brand)' : 'var(--bg)',
        color: on ? '#fff' : 'var(--text-3)',
        fontSize: '0.72rem',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'background 150ms ease',
        padding: 0,
        lineHeight: 1,
      }}
    >
      {on ? 'On' : 'Off'}
    </button>
  );

  if (loading) return (
    <><NavBar /><main className="page"><div className="container container--sm">
      <div className="loading"><div className="spinner spinner--lg" /></div>
    </div></main></>
  );

  return (
    <><NavBar />
    <main className="page"><div className="container container--sm" style={{ paddingBottom: 40 }}>
      <h1 className="page-title" style={{ marginBottom: 24 }}>Settings</h1>

      {saved && (
        <div className="alert alert--success" style={{ marginBottom: 16, animation: 'fadeIn .15s ease' }}>
          Saved
        </div>
      )}

      {/* ── Section 1: Appearance ── */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="form-label" style={{ marginBottom: 10 }}>Appearance</div>
        <div style={{ display: 'inline-flex', borderRadius: 'var(--r-pill)', overflow: 'hidden', border: '1px solid var(--border)' }}>
          {[
            { value: 'light', label: 'Light' },
            { value: null,    label: 'System' },
            { value: 'dark',  label: 'Dark' },
          ].map(opt => {
            const active = theme === opt.value;
            return (
              <button
                key={opt.label}
                type="button"
                onClick={() => setTheme(opt.value)}
                style={{
                  padding: '7px 18px',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  border: 'none',
                  background: active ? 'var(--brand)' : 'var(--bg)',
                  color: active ? '#fff' : 'var(--text-3)',
                  transition: 'background 150ms ease, color 150ms ease',
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Section 2: Notifications ── */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="form-label" style={{ marginBottom: 12 }}>Notifications</div>

        {/* Push permission banner */}
        {permissionState === 'ios_non_pwa' && (
          <div className="card card-pad" style={{ marginBottom: 16, background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 8 }}>
              📱 Add Rendezvous to your home screen to enable notifications
            </div>
            <ol style={{ paddingLeft: 18, margin: 0, fontSize: '0.78rem', color: 'var(--text-3)', lineHeight: 1.8 }}>
              <li>Tap the Share button at the bottom of Safari (the box with an arrow pointing up ↑)</li>
              <li>Scroll down and tap "Add to Home Screen"</li>
              <li>Tap "Add" in the top right corner</li>
              <li>Open Rendezvous from your home screen</li>
              <li>Come back to Settings and enable notifications here</li>
            </ol>
          </div>
        )}

        {permissionState === 'granted' && (
          <div style={{ color: 'var(--success)', fontSize: '0.85rem', fontWeight: 600, marginBottom: 12 }}>
            ✓ Push notifications enabled
          </div>
        )}

        {permissionState === 'default' && (
          <div style={{ marginBottom: 12 }}>
            <button type="button" className="btn btn--secondary btn--sm" onClick={handleEnablePush}>
              Enable push notifications
            </button>
          </div>
        )}

        {permissionState === 'denied' && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-2)', marginBottom: 4 }}>
              Push notifications are blocked by your browser.
            </div>
            <div className="form-hint">
              To re-enable: click the lock icon in your browser's address bar → Notifications → Allow, then reload the page.
            </div>
          </div>
        )}

        {permissionState === 'unsupported' && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-3)', marginBottom: 12 }}>
            Push notifications are not supported in this browser.
          </div>
        )}

        {/* Toggle table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: 'left', padding: '8px 8px 8px 0', fontWeight: 600, color: 'var(--text-3)', fontSize: '0.78rem' }}>Type</th>
                <th style={{ textAlign: 'center', padding: '8px 4px', fontWeight: 600, color: 'var(--text-3)', fontSize: '0.78rem', width: 56 }}>In-app</th>
                <th style={{ textAlign: 'center', padding: '8px 0 8px 4px', fontWeight: 600, color: 'var(--text-3)', fontSize: '0.78rem', width: 56 }}>Push</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_GROUPS.map(group => (
                <React.Fragment key={group.label}>
                  <tr>
                    <td colSpan={3} style={{ padding: '12px 0 4px', fontWeight: 700, fontSize: '0.78rem', color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
                      {group.label}
                    </td>
                  </tr>
                  {group.types.map(t => (
                    <tr key={t.key} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 8px 10px 0', color: 'var(--text-2)' }}>{t.label}</td>
                      <td style={{ textAlign: 'center', padding: '10px 4px' }}>
                        <Toggle
                          on={getChannel(settings, t.key, 'in_product')}
                          onClick={() => toggleChannel(t.key, 'in_product')}
                        />
                      </td>
                      <td style={{ textAlign: 'center', padding: '10px 0 10px 4px' }}>
                        <Toggle
                          on={getChannel(settings, t.key, 'push')}
                          onClick={() => toggleChannel(t.key, 'push')}
                          disabled={pushDisabled}
                        />
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Section 3: Privacy ── */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="form-label" style={{ marginBottom: 12 }}>Privacy</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text)' }}>
              Allow group invites from non-friends
            </div>
            <div className="form-hint">If off, only friends can add you to groups.</div>
          </div>
          <Toggle on={privacy} onClick={togglePrivacy} />
        </div>
      </div>

    </div></main></>
  );
}
