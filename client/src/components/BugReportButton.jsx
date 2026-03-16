// BugReportButton.jsx — floating feedback + bug report buttons
//
// Renders two pill-shaped floating buttons fixed to the bottom-right corner.
// Top button: "Feedback" → opens Google Form in a new tab (no modal).
// Bottom button: "Report a bug" → opens modal with category + freeform message.
//
// Only renders when the user is logged in (getSupabaseId() non-null).
// Does not render on /onboarding.
// Import once in App.js so it appears on every protected route.

import React, { useState, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { getSupabaseId } from '../utils/auth';
import client from '../utils/client';

const CATEGORIES = [
  'Something broke',
  'Wrong info in itinerary',
  'Bad suggestion quality',
  'Other',
];

const FEEDBACK_URL    = 'https://docs.google.com/forms/d/e/1FAIpQLSeAk1O_pPiJh376XybMTIWFnj0kKczYOzU2AeRoIsmrJbRFBw/viewform';
const DISCORD_INVITE_URL = 'https://discord.gg/6xc8ERrDDb';

export default function BugReportButton() {
  const location = useLocation();

  const [expanded,   setExpanded]   = useState(false);
  const [showModal,  setShowModal]  = useState(false);
  const [category,   setCategory]   = useState(CATEGORIES[0]);
  const [message,    setMessage]    = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success,    setSuccess]    = useState(false);
  const [error,      setError]      = useState('');
  const stackRef = useRef(null);

  // Click-away to collapse (same pattern as NotificationBell.js)
  useEffect(() => {
    if (!expanded) return;
    function handleMouseDown(e) {
      if (stackRef.current && !stackRef.current.contains(e.target)) setExpanded(false);
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [expanded]);

  // Only render for authenticated users, never on /onboarding
  if (!getSupabaseId() || location.pathname === '/onboarding') return null;

  function openModal() {
    setShowModal(true);
    setCategory(CATEGORIES[0]);
    setMessage('');
    setSuccess(false);
    setError('');
  }

  function closeModal() {
    if (submitting) return;
    setShowModal(false);
  }

  async function handleSubmit() {
    if (!message.trim()) { setError('Please describe the issue.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await client.post('/bug-report', {
        category,
        message:  message.trim(),
        page_url: window.location.href,
      });
      setSuccess(true);
      setTimeout(() => { setShowModal(false); setSuccess(false); }, 2000);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const btnStyle = {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    padding:       '7px 14px',
    background:    'var(--surface)',
    border:        '1px solid var(--border)',
    borderRadius:  'var(--r-pill)',
    boxShadow:     'var(--shadow-sm)',
    cursor:        'pointer',
    fontSize:      '0.8rem',
    fontWeight:    700,
    color:         'var(--text-2)',
    lineHeight:    1.2,
    textDecoration: 'none',
    whiteSpace:    'nowrap',
  };

  const subStyle = {
    fontSize:   '0.68rem',
    fontWeight: 400,
    color:      'var(--text-3)',
    marginTop:  2,
  };

  return (
    <>
      {/* Floating button stack */}
      <div className="bug-report-btns" ref={stackRef}>
        {expanded && (
          <>
            {/* Discord — opens invite in a new tab */}
            <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" style={btnStyle}>
              <span>💬 Discord</span>
              <span style={subStyle}>Join the community</span>
            </a>

            {/* Feedback — opens Google Form in a new tab */}
            <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer" style={btnStyle}>
              <span>💬 Feedback</span>
              <span style={subStyle}>Suggestions &amp; improvements</span>
            </a>

            {/* Bug report — opens modal */}
            <button onClick={openModal} style={btnStyle}>
              <span>🐛 Report a bug</span>
              <span style={subStyle}>Issues during your experience</span>
            </button>
          </>
        )}

        {/* Toggle button — always visible */}
        <button onClick={() => setExpanded(prev => !prev)} style={{ ...btnStyle, flexDirection: 'row', gap: 6 }}>
          <span>Feedback</span>
          <span style={{ fontSize: '0.7rem', lineHeight: 1 }}>{expanded ? '▼' : '▲'}</span>
        </button>
      </div>

      {/* Bug report modal */}
      {showModal && (
        <div
          className="modal-backdrop"
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="bug-modal-title">
            <div className="modal__header">
              <span className="modal__title" id="bug-modal-title">Report a bug</span>
              <button className="modal__close" onClick={closeModal} aria-label="Close" disabled={submitting}>
                ×
              </button>
            </div>

            <div className="modal__body">
              {success ? (
                <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--success)', fontWeight: 600 }}>
                  ✓ Thanks — reported!
                </div>
              ) : (
                <>
                  {error && (
                    <div className="alert alert--error" style={{ marginBottom: 14, fontSize: '0.87rem' }}>
                      {error}
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label" htmlFor="bug-category">What happened?</label>
                    <select
                      id="bug-category"
                      className="form-control"
                      value={category}
                      onChange={e => setCategory(e.target.value)}
                      disabled={submitting}
                    >
                      {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="bug-message">
                      Describe what went wrong <span style={{ color: 'var(--error)' }}>*</span>
                    </label>
                    <textarea
                      id="bug-message"
                      className="form-control"
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      rows={4}
                      disabled={submitting}
                      placeholder="What were you doing? What did you expect to happen?"
                    />
                  </div>
                </>
              )}
            </div>

            {!success && (
              <div className="modal__footer">
                <button className="btn btn--ghost" onClick={closeModal} disabled={submitting}>
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  onClick={handleSubmit}
                  disabled={submitting || !message.trim()}
                >
                  {submitting ? '…' : 'Submit'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
