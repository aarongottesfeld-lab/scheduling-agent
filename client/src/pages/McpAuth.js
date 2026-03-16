// McpAuth.js — OAuth consent page for MCP (AI client authorization)
//
// When an AI client (Claude Desktop, ChatGPT, etc.) wants to connect to
// Rendezvous on behalf of a user, the MCP server redirects here:
//   /mcp-auth?auth_request_id=...&client_id=...&scope=...&challenge_token=...
//
// The user must be logged in. If not, they're redirected to / to sign in,
// then bounced back here via sessionStorage key.
//
// On Allow: navigates to MCP server's /oauth/callback which completes
// the code exchange and redirects to the AI client.
// On Deny: shows a brief message, then redirects to /home.

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { isAuthenticated, getSupabaseId } from '../utils/auth';
import client from '../utils/client';

const MCP_SERVER_URL = process.env.REACT_APP_MCP_SERVER_URL || 'http://localhost:3002';

export default function McpAuth() {
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
  const [denying, setDenying] = useState(false);
  const [error, setError] = useState(null);
  const [userName, setUserName] = useState('');

  const authRequestId = searchParams.get('auth_request_id');
  const clientId = searchParams.get('client_id');
  const scope = searchParams.get('scope');
  const challengeToken = searchParams.get('challenge_token');

  const hasRequiredParams = authRequestId && clientId && scope && challengeToken;

  // Auth check + profile fetch
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

    client.get('/users/me')
      .then(res => {
        setUserName(res.data.full_name || res.data.username || 'User');
      })
      .catch(() => {
        setUserName('User');
      })
      .finally(() => setLoading(false));
  }, [hasRequiredParams]);

  function handleAllow() {
    setApproving(true);
    const userId = getSupabaseId();
    const callbackUrl = `${MCP_SERVER_URL}/oauth/callback?auth_request_id=${encodeURIComponent(authRequestId)}&user_id=${encodeURIComponent(userId)}&challenge_token=${encodeURIComponent(challengeToken)}`;
    window.location.href = callbackUrl;
  }

  function handleDeny() {
    setDenying(true);
    setTimeout(() => {
      window.location.href = '/home';
    }, 1500);
  }

  const displayClientId = clientId && clientId.length > 40
    ? clientId.slice(0, 40) + '...'
    : clientId;

  // Denying state
  if (denying) {
    return (
      <div className="page-center">
        <div className="card card-pad" style={{ maxWidth: 420, textAlign: 'center' }}>
          <p style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text-2)' }}>
            Access denied. Redirecting...
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
        <div className="card card-pad" style={{ maxWidth: 420, textAlign: 'center' }}>
          <div style={{ fontSize: '1.5rem', marginBottom: 12 }}>
            <span style={{ color: 'var(--brand)', fontWeight: 800 }}>Rendezvous</span>
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
      <div className="card card-pad" style={{ maxWidth: 420 }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <span style={{ color: 'var(--brand)', fontWeight: 800, fontSize: '1.3rem' }}>
            Rendezvous
          </span>
        </div>

        <p style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
          <strong>{displayClientId}</strong> wants to connect to your Rendezvous account
        </p>

        <p style={{ fontSize: '0.85rem', color: 'var(--text-3)', marginBottom: 20 }}>
          Signed in as <strong style={{ color: 'var(--text-2)' }}>{userName}</strong>
        </p>

        <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-2)', marginBottom: 10 }}>
          This will allow:
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[
            'View your friends list',
            'Check your availability',
            'Create and manage plans',
            'Vote on group plans',
          ].map(item => (
            <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: 'var(--text-2)' }}>
              <span style={{ color: 'var(--success)', fontSize: '0.9rem', flexShrink: 0 }}>&#10003;</span>
              {item}
            </li>
          ))}
        </ul>

        <p className="form-hint" style={{ marginBottom: 20 }}>
          Your calendar credentials are never shared.
        </p>

        <button
          className="btn btn--primary btn--full btn--lg"
          onClick={handleAllow}
          disabled={approving}
          style={{ marginBottom: 10 }}
        >
          {approving ? 'Connecting...' : 'Allow'}
        </button>

        <button
          className="btn btn--ghost btn--full"
          onClick={handleDeny}
          disabled={approving}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
