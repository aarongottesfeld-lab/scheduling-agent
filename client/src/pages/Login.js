// Login.js — entry point for unauthenticated users.
//
// Authenticated users are redirected immediately (unchanged from original).
// Unauthenticated users see the full landing page: hero, feature scroll, final CTA.

import React, { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { isAuthenticated, isNewUser, clearNewUser } from '../utils/auth';
import { getGoogleAuthUrl } from '../utils/api';
import './Landing.css';

/* ── Google "G" mark ─────────────────────────────────────── */
function GoogleG() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      <path fill="none" d="M0 0h48v48H0z"/>
    </svg>
  );
}

/* ── Reusable auth button ────────────────────────────────── */
function AuthButton() {
  return (
    <a href={getGoogleAuthUrl()} className="lp-cta-btn" aria-label="Connect Google Calendar to sign in">
      <GoogleG />
      Connect Google Calendar
    </a>
  );
}

function PrivacyNote() {
  return (
    <p className="lp-privacy">
      We only read your free/busy times. We never see your event details.
    </p>
  );
}

/* ── Intersection Observer hook ──────────────────────────── */
function useInView(threshold = 0.18) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setInView(true); },
      { threshold }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
}

/* ── SVG mock: two calendar grids with overlap ───────────── */
function CalendarOverlapSVG() {
  // Two 7-col × 5-row grids; busy cells in rose, free-overlap cells in indigo
  const busyA = new Set([2, 3, 8, 9, 15, 16, 22]);
  const busyB = new Set([0, 1, 5, 12, 13, 19, 20, 26]);
  const freeOverlap = new Set([4, 6, 10, 11, 17, 18, 24, 25, 27, 28]);

  function renderGrid(busy, ox, oy, label) {
    const cells = [];
    for (let i = 0; i < 35; i++) {
      const col = i % 7;
      const row = Math.floor(i / 7);
      const x = ox + col * 20 + col * 2;
      const y = oy + row * 14 + row * 2;
      const isBusy = busy.has(i);
      const isOverlap = freeOverlap.has(i);
      const fill = isBusy ? '#991b1b' : isOverlap ? '#4f46e5' : '#1e1e2e';
      const opacity = isBusy ? 0.7 : isOverlap ? 0.85 : 0.4;
      cells.push(
        <rect key={i} x={x} y={y} width={18} height={12} rx={3}
          fill={fill} opacity={opacity} />
      );
    }
    return (
      <g>
        <text x={ox + 62} y={oy - 10} textAnchor="middle"
          fill="#5c5c80" fontSize="10" fontFamily="Inter, sans-serif">{label}</text>
        {cells}
      </g>
    );
  }

  return (
    <svg viewBox="0 0 320 200" width="100%" style={{ maxWidth: 360, borderRadius: 16, overflow: 'visible' }} aria-hidden="true">
      {/* Grid A */}
      {renderGrid(busyA, 10, 30, 'Your calendar')}
      {/* Grid B */}
      {renderGrid(busyB, 170, 30, 'Their calendar')}
      {/* Legend */}
      <rect x="10" y="175" width="10" height="8" rx="2" fill="#991b1b" opacity="0.7" />
      <text x="24" y="183" fill="#5c5c80" fontSize="9" fontFamily="Inter, sans-serif">Busy</text>
      <rect x="60" y="175" width="10" height="8" rx="2" fill="#4f46e5" opacity="0.85" />
      <text x="74" y="183" fill="#5c5c80" fontSize="9" fontFamily="Inter, sans-serif">Both free</text>
    </svg>
  );
}

/* ── HTML mock: suggestion card ──────────────────────────── */
function SuggestionCardMock() {
  return (
    <div style={{
      background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
      borderRadius: 20,
      overflow: 'hidden',
      width: '100%',
      maxWidth: 340,
      boxShadow: '0 20px 60px rgba(79,70,229,.35)',
      fontFamily: 'Inter, sans-serif',
    }}>
      {/* Header */}
      <div style={{ padding: '18px 20px 14px' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'rgba(255,255,255,.7)', marginBottom: 4 }}>
          Saturday, Mar 21 · Williamsburg
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <span style={{ background: 'rgba(255,255,255,.2)', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '2px 9px', borderRadius: 99 }}>
            Evening out
          </span>
          <span style={{ background: 'rgba(255,255,255,.2)', color: '#fff', fontSize: '0.7rem', fontWeight: 700, padding: '2px 9px', borderRadius: 99 }}>
            ~3 hrs
          </span>
        </div>
      </div>
      {/* Body */}
      <div style={{ background: '#0f0f13', padding: '16px 20px' }}>
        <p style={{ fontSize: '0.82rem', color: '#7878a0', lineHeight: 1.6, marginBottom: 14 }}>
          A low-key evening starting with drinks, followed by some of Brooklyn's best pasta,
          then wrapping with craft cocktails nearby.
        </p>
        {[
          { name: 'The Ides', type: 'Rooftop bar', addr: '80 Wythe Ave' },
          { name: 'Lilia',    type: 'Italian',    addr: '567 Union Ave' },
          { name: 'Nitecap',  type: 'Cocktails',  addr: '105 Rivington' },
        ].map((v, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366f1', flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#f0f0f5' }}>{v.name}</span>
            <span style={{ fontSize: '0.72rem', color: '#5c5c72', background: '#1e1e2a', borderRadius: 6, padding: '1px 7px' }}>{v.type}</span>
          </div>
        ))}
        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <button style={{
            background: '#6366f1', color: '#fff', border: 'none', borderRadius: 10,
            padding: '9px 18px', fontWeight: 700, fontSize: '0.85rem', cursor: 'default',
          }}>Pick this one</button>
          <button style={{
            background: 'transparent', color: '#5c5c80', border: '1px solid #2a2a38',
            borderRadius: 10, padding: '9px 14px', fontWeight: 600, fontSize: '0.82rem', cursor: 'default',
          }}>New vibe 🎲</button>
        </div>
      </div>
    </div>
  );
}

/* ── SVG mock: phone with calendar event ─────────────────── */
function PhoneCalendarSVG() {
  return (
    <svg viewBox="0 0 180 300" width="100%" style={{ maxWidth: 200 }} aria-hidden="true">
      {/* Phone body */}
      <rect x="10" y="10" width="160" height="280" rx="24" fill="#1a1a24" stroke="#2e2e3e" strokeWidth="1.5" />
      {/* Notch */}
      <rect x="60" y="18" width="60" height="10" rx="5" fill="#0f0f13" />
      {/* Screen content */}
      {/* Month header */}
      <text x="90" y="52" textAnchor="middle" fill="#5c5c80" fontSize="10" fontFamily="Inter, sans-serif" fontWeight="700">MARCH 2026</text>
      {/* Day headers */}
      {['S','M','T','W','T','F','S'].map((d, i) => (
        <text key={d+i} x={26 + i * 20} y="68" textAnchor="middle" fill="#3a3a52" fontSize="8" fontFamily="Inter, sans-serif">{d}</text>
      ))}
      {/* Calendar cells — week rows */}
      {[
        [null,null,null,null,null,null,1],
        [2,3,4,5,6,7,8],
        [9,10,11,12,13,14,15],
        [16,17,18,19,20,21,22],
        [23,24,25,26,27,28,29],
      ].map((row, ri) =>
        row.map((day, ci) => day ? (
          <text key={`${ri}-${ci}`} x={26 + ci * 20} y={82 + ri * 18}
            textAnchor="middle" fill={day === 21 ? '#fff' : '#5c5c80'}
            fontSize="9" fontFamily="Inter, sans-serif" fontWeight={day === 21 ? 700 : 400}>
            {day}
          </text>
        ) : null)
      )}
      {/* Highlight day 21 */}
      <circle cx="126" cy="79" r="9" fill="#6366f1" />
      <text x="126" y="82" textAnchor="middle" fill="#fff" fontSize="9" fontFamily="Inter, sans-serif" fontWeight="700">21</text>
      {/* Calendar event block */}
      <rect x="22" y="178" width="136" height="50" rx="10" fill="#6366f1" opacity="0.92" />
      <text x="34" y="196" fill="#fff" fontSize="9" fontFamily="Inter, sans-serif" fontWeight="700">Evening in Williamsburg</text>
      <text x="34" y="210" fill="rgba(255,255,255,.7)" fontSize="8" fontFamily="Inter, sans-serif">7:00 PM – 10:00 PM</text>
      <text x="34" y="222" fill="rgba(255,255,255,.6)" fontSize="8" fontFamily="Inter, sans-serif">Lilia · The Ides · Nitecap</text>
      {/* Second smaller event */}
      <rect x="22" y="236" width="90" height="24" rx="8" fill="#14142a" />
      <text x="30" y="252" fill="#5c5c80" fontSize="8" fontFamily="Inter, sans-serif">Lunch with Jamie</text>
    </svg>
  );
}

/* ── Feature section ─────────────────────────────────────── */
function FeatureSection({ eyebrow, title, body, visual, reversed }) {
  const [ref, inView] = useInView();
  return (
    <div ref={ref} className={`lp-feature${reversed ? ' lp-feature--reversed' : ''}`}>
      <div className={`lp-feature__text lp-animate${inView ? ' lp-animate--in' : ''}${reversed ? ' lp-animate--delay-1' : ''}`}>
        <div className="lp-feature__eyebrow">{eyebrow}</div>
        <h2 className="lp-feature__title">{title}</h2>
        <p className="lp-feature__body">{body}</p>
      </div>
      <div className={`lp-feature__visual lp-animate${inView ? ' lp-animate--in' : ''}${reversed ? '' : ' lp-animate--delay-1'}`}>
        {visual}
      </div>
    </div>
  );
}

/* ── Landing page ────────────────────────────────────────── */
function LandingPage() {
  const heroRef = useRef(null);
  const [showFloat, setShowFloat] = useState(false);

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const obs = new IntersectionObserver(
      ([entry]) => setShowFloat(!entry.isIntersecting),
      { threshold: 0.1 }
    );
    obs.observe(hero);
    return () => obs.disconnect();
  }, []);

  const [finalRef, finalInView] = useInView(0.2);

  return (
    <div className="lp-root">

      {/* ── Section 1: Hero ── */}
      <section ref={heroRef} className="lp-hero">
        <div className="lp-wordmark">Rendezvous</div>
        <h1 className="lp-headline">
          Stop suggesting.<br />Start going.
        </h1>
        <p className="lp-subhead">
          Connect your calendar. Pick your people.<br />
          Get an itinerary worth showing up for.
        </p>
        <AuthButton />
        <p className="form-hint" style={{ marginTop: 8, textAlign: 'center' }}>After signing in, you can connect Apple Calendar and additional Google calendars from your profile settings.</p>
        <PrivacyNote />
        <div className="lp-scroll-hint" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          scroll
        </div>
      </section>

      {/* ── Section 2: Feature scroll ── */}
      <div className="lp-features">
        <FeatureSection
          eyebrow="01 — Scheduling"
          title="Finding time is the hard part. We handle it."
          body="Rendezvous reads both calendars and surfaces windows when you're both actually free — no back-and-forth, no spreadsheets, no polling a group chat."
          visual={<CalendarOverlapSVG />}
          reversed={false}
        />
        <FeatureSection
          eyebrow="02 — Planning"
          title="Three real plans, not a list of Yelp results."
          body="Tell us your vibe, your neighborhood, your constraints. The AI comes back with three full itineraries — venues, timing, route — tailored to both of you."
          visual={<SuggestionCardMock />}
          reversed={true}
        />
        <FeatureSection
          eyebrow="03 — Confirmation"
          title="Locked in. On both calendars."
          body="When you both agree, Rendezvous creates the calendar event automatically. No copy-pasting, no 'wait, what time was it?', no forgetting."
          visual={<PhoneCalendarSVG />}
          reversed={false}
        />
      </div>

      {/* ── Section 3: Final CTA ── */}
      <section ref={finalRef} className="lp-final">
        <h2 className={`lp-final__headline lp-animate${finalInView ? ' lp-animate--in' : ''}`}>
          Your next plans are waiting.
        </h2>
        <div className={`lp-animate lp-animate--delay-1${finalInView ? ' lp-animate--in' : ''}`}>
          <AuthButton />
          <p className="form-hint" style={{ marginTop: 8, textAlign: 'center' }}>After signing in, you can connect Apple Calendar and additional Google calendars from your profile settings.</p>
          <PrivacyNote />
        </div>
      </section>

      {/* ── Floating CTA ── */}
      <a
        href={getGoogleAuthUrl()}
        className={`lp-float${showFloat ? ' lp-float--visible' : ''}`}
        aria-label="Get started with Rendezvous"
      >
        Get Started →
      </a>

    </div>
  );
}

/* ── Main export ─────────────────────────────────────────── */
export default function Login() {
  // Authenticated redirect
  if (isAuthenticated()) {
    if (isNewUser()) {
      clearNewUser();
      return <Navigate to="/profile/setup" replace />;
    }
    // Check for pending MCP auth flow that redirected here for login
    const mcpReturn = sessionStorage.getItem('mcp_auth_return_url');
    if (mcpReturn) {
      sessionStorage.removeItem('mcp_auth_return_url');
      return <Navigate to={mcpReturn} replace />;
    }
    return <Navigate to="/home" replace />;
  }

  return <LandingPage />;
}
