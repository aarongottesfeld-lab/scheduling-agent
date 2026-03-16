// McpAuth.js — OAuth consent page for MCP (AI client authorization)
//
// When an AI client (Claude Desktop, ChatGPT, etc.) wants to connect to
// Rendezvous on behalf of a user, the MCP server redirects here:
//   /mcp-auth?auth_request_id=...&client_id=...&scope=...&challenge_token=...
//
// The user must be logged in. If not, they're redirected to / to sign in,
// then bounced back here via sessionStorage key.
//
// On Allow: shows a success screen, then navigates to MCP server's
// /oauth/callback which completes the code exchange and redirects to the AI client.
// On Deny: shows a brief message, then redirects to /home.

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isAuthenticated, getSupabaseId } from '../utils/auth';
import client from '../utils/client';

const MCP_SERVER_URL_FALLBACK = process.env.REACT_APP_MCP_SERVER_URL || 'http://localhost:3002';

const PERMISSIONS = [
  'View your friends and friend requests',
  'Check your calendar availability',
  'Create and manage 1-on-1 plans',
  'Create and manage group plans',
  'Accept, decline, or vote on plans',
  'Send and respond to friend requests',
  'Receive plan notifications',
];

function Logomark() {
  return (
    <div style={{
      width: 56, height: 56, borderRadius: '50%', background: 'var(--brand)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      margin: '0 auto 10px',
    }}>
      <span style={{ color: '#fff', fontWeight: 900, fontSize: '1.6rem', lineHeight: 1 }}>R</span>
    </div>
  );
}

function CheckIcon() {
  return (
    <span style={{
      width: 16, height: 16, borderRadius: '50%', background: 'var(--success-bg)',
      color: 'var(--success)', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '0.65rem', fontWeight: 700, flexShrink: 0,
      lineHeight: 1,
    }}>&#10003;</span>
  );
}

function UserPill({ userName, avatarUrl }) {
  const initials = (userName || 'U').charAt(0).toUpperCase();
  return (
    <div style={{
      background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-pill)', padding: '8px 14px',
      display: 'flex', alignItems: 'center', gap: 10,
      margin: '0 auto 20px', width: 'fit-content', maxWidth: '100%',
    }}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="" style={{
          width: 28, height: 28, borderRadius: '50%', objectFit: 'cover', flexShrink: 0,
        }} />
      ) : (
        <div style={{
          width: 28, height: 28, borderRadius: '50%',
          background: 'linear-gradient(135deg, var(--brand) 0%, #a78bfa 100%)',
          color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 800, fontSize: '0.7rem', flexShrink: 0,
        }}>{initials}</div>
      )}
      <span style={{ fontSize: '0.85rem', color: 'var(--text-2)', fontWeight: 500 }}>
        {userName}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={() => { window.location.href = '/'; }}
        onKeyDown={e => { if (e.key === 'Enter') window.location.href = '/'; }}
        style={{
          fontSize: '0.78rem', color: 'var(--brand)', cursor: 'pointer',
          marginLeft: 'auto', whiteSpace: 'nowrap',
        }}
      >Not you?</span>
    </div>
  );
}

const cardStyle = {
  maxWidth: 400, padding: 32, boxShadow: 'var(--shadow-lg)', borderRadius: 'var(--r-lg)',
};

export default function McpAuth() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState(null);
  const [denying, setDenying] = useState(false);
  const [error, setError] = useState(null);
  const [userName, setUserName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [clientName, setClientName] = useState(null);

  const authRequestId = searchParams.get('auth_request_id');
  const clientId = searchParams.get('client_id');
  const scope = searchParams.get('scope');
  const challengeToken = searchParams.get('challenge_token');
  const mcpServerUrl = searchParams.get('mcp_server_url') || MCP_SERVER_URL_FALLBACK;

  const hasRequiredParams = authRequestId && clientId && scope && challengeToken;

  // Auth check + profile fetch + client name lookup
  useEffect(() => {
    if (!isAuthenticated()) {
      sessionStorage.setItem('mcp_auth_return_url', window.location.pathname + window.location.search);
      window.location.href = '/';
      return;
    }

    if (!hasRequiredParams) {
      setError('Invalid authorization request. Please try connecting again from your AI assistant.');
      setLoading(false);
      return;
    }

    // Fetch user profile and client name in parallel
    const profilePromise = client.get('/users/me')
      .then(res => {
        setUserName(res.data.full_name || res.data.username || 'User');
        setAvatarUrl(res.data.avatar_url || null);
      })
      .catch(() => {
        setUserName('User');
      });

    const clientInfoPromise = fetch(`${mcpServerUrl}/oauth/client-info?client_id=${encodeURIComponent(clientId)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.client_name) setClientName(data.client_name);
      })
      .catch(() => {});

    Promise.all([profilePromise, clientInfoPromise])
      .finally(() => setLoading(false));
  }, [hasRequiredParams, clientId, mcpServerUrl]);

  const displayName = clientName || (clientId && clientId.length > 40
    ? clientId.slice(0, 40) + '...'
    : clientId);

  const clientLabel = clientName || 'your AI assistant';

  function handleAllow() {
    setApproving(true);
    const userId = getSupabaseId();
    const url = `${mcpServerUrl}/oauth/callback?auth_request_id=${encodeURIComponent(authRequestId)}&user_id=${encodeURIComponent(userId)}&challenge_token=${encodeURIComponent(challengeToken)}`;
    setCallbackUrl(url);
    setApproved(true);
    // 1.5s delay gives the success screen time to render and be seen
    // before the redirect fires. If the AI client doesn't intercept,
    // the user has the manual Return button as a fallback.
    setTimeout(() => {
      window.location.href = url;
    }, 1500);
  }

  function handleDeny() {
    setDenying(true);
    setTimeout(() => {
      window.location.href = '/home';
    }, 1500);
  }

  // Approved state — success screen
  if (approved) {
    return (
      <div className="page-center">
        <div className="card" style={{ ...cardStyle, textAlign: 'center' }}>
          <Logomark />
          <div style={{ color: 'var(--brand)', fontWeight: 800, fontSize: '1.1rem', marginBottom: 20 }}>
            Rendezvous
          </div>

          <div style={{
            width: 40, height: 40, borderRadius: '50%', background: 'var(--success-bg)',
            color: 'var(--success)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.4rem', fontWeight: 700, margin: '0 auto 16px', lineHeight: 1,
          }}>&#10003;</div>

          <p style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
            Connected successfully
          </p>
          <p className="form-hint" style={{ marginBottom: 24, textAlign: 'center' }}>
            You can now use Rendezvous from {clientLabel}. This tab will close automatically.
          </p>

          <button
            className="btn btn--primary btn--full"
            onClick={() => { if (callbackUrl) window.location.href = callbackUrl; }}
          >
            Return to {clientLabel}
          </button>

          <a
            href="/home"
            style={{
              display: 'block', textAlign: 'center', marginTop: 10,
              fontSize: '0.85rem', color: 'var(--text-3)',
            }}
          >
            Go to Rendezvous
          </a>
        </div>
      </div>
    );
  }

  // Denying state
  if (denying) {
    return (
      <div className="page-center">
        <div className="card" style={{ ...cardStyle, textAlign: 'center' }}>
          <Logomark />
          <p style={{ fontSize: '0.95rem', fontWeight: 500, color: 'var(--text-3)', marginTop: 16 }}>
            Access cancelled
          </p>
        </div>
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div className="page-center">
        <div className="loading">
          <div className="spinner spinner--lg" />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="page-center">
        <div className="card" style={{ ...cardStyle, textAlign: 'center' }}>
          <Logomark />
          <div style={{ color: 'var(--brand)', fontWeight: 800, fontSize: '1.1rem', marginBottom: 16 }}>
            Rendezvous
          </div>
          <div className="alert alert--error" style={{ textAlign: 'left' }}>
            {error}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-center">
      <div className="card" style={cardStyle}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <Logomark />
          <div style={{ color: 'var(--brand)', fontWeight: 800, fontSize: '1.1rem' }}>
            Rendezvous
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0 0 20px' }} />

        {/* Title */}
        <p style={{
          fontSize: '1.05rem', fontWeight: 500, color: 'var(--text)',
          textAlign: 'center', marginBottom: 16, lineHeight: 1.45,
        }}>
          <strong>{displayName}</strong> would like access to your Rendezvous account
        </p>

        {/* Signed-in account pill */}
        <UserPill userName={userName} avatarUrl={avatarUrl} />

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '0 0 16px' }} />

        {/* Permissions */}
        <p style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 10 }}>
          This will allow
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {PERMISSIONS.map(item => (
            <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.875rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
              <CheckIcon />
              {item}
            </li>
          ))}
        </ul>

        {/* Privacy note */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <p className="form-hint" style={{ margin: 0 }}>
            Your calendar credentials are never shared with AI clients.
          </p>
          <p className="form-hint" style={{ margin: '2px 0 0' }}>
            Access can be revoked at any time from your Rendezvous settings.
          </p>
        </div>

        {/* Allow button */}
        <button
          className="btn btn--primary btn--lg btn--full"
          onClick={handleAllow}
          disabled={approving}
        >
          {approving ? 'Connecting\u2026' : 'Allow access'}
        </button>

        {/* Cancel link */}
        <button
          onClick={handleDeny}
          disabled={approving}
          style={{
            display: 'block', width: '100%', textAlign: 'center',
            marginTop: 10, padding: '8px 0', background: 'none', border: 'none',
            fontSize: '0.85rem', color: 'var(--text-3)', cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
