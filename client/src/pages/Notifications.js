// Notifications.js — full notifications history page
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import NavBar from '../components/NavBar';
import client from '../utils/client';

function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts)) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

const TYPE_ICON = {
  friend_request:     '👋',
  itinerary_invite:   '📅',
  itinerary_accepted: '✅',
  itinerary_declined: '❌',
  itinerary_reroll:   '🔄',
};

const TYPE_LABEL = {
  friend_request:     'Friend request',
  itinerary_invite:   'Itinerary invite',
  itinerary_accepted: 'Accepted',
  itinerary_declined: 'Declined',
  itinerary_reroll:   'Re-roll request',
};

export default function Notifications() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error,   setError]     = useState('');

  const load = useCallback(async () => {
    try {
      const res = await client.get('/notifications');
      setNotifications(res.data.notifications || []);
    } catch {
      setError('Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function markAllRead() {
    await client.post('/notifications/read-all').catch(() => {});
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }

  async function handleClick(n) {
    if (!n.read) {
      await client.post(`/notifications/${n.id}/read`).catch(() => {});
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
    }
    if (n.action_url) navigate(n.action_url);
  }

  const unread = notifications.filter(n => !n.read).length;

  return (
    <>
      <NavBar />
      <main className="page">
        <div className="container container--sm">
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
            <div>
              <h1 className="page-title">Notifications</h1>
              <p className="page-subtitle">Everything that's happened recently.</p>
            </div>
            {unread > 0 && (
              <button className="btn btn--ghost btn--sm" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </div>

          {error && <div className="alert alert--error">{error}</div>}

          {loading ? (
            <div className="loading"><div className="spinner spinner--lg" /></div>
          ) : notifications.length === 0 ? (
            <div className="card card-pad">
              <div className="empty-state">
                <div className="empty-state__icon">🔔</div>
                <div className="empty-state__title">Nothing yet</div>
                <p className="empty-state__text">Friend requests and itinerary updates will show up here.</p>
              </div>
            </div>
          ) : (
            <div className="card" style={{ overflow:'hidden' }}>
              {notifications.map((n, i) => (
                <div
                  key={n.id}
                  className={`notif-item${n.read ? '' : ' notif-item--unread'}`}
                  onClick={() => handleClick(n)}
                  style={{ borderBottom: i < notifications.length - 1 ? '1px solid var(--border)' : 'none', cursor: n.action_url ? 'pointer' : 'default' }}
                >
                  <span className="notif-item__icon">{TYPE_ICON[n.type] || '🔔'}</span>
                  <div className="notif-item__body">
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <div className="notif-item__title">{n.title}</div>
                      {TYPE_LABEL[n.type] && (
                        <span className="badge badge--gray" style={{ fontSize:'0.68rem' }}>{TYPE_LABEL[n.type]}</span>
                      )}
                    </div>
                    {n.body && <div className="notif-item__sub">{n.body}</div>}
                    <div className="notif-item__time">{timeAgo(n.created_at)}</div>
                  </div>
                  {!n.read && <span className="notif-item__dot" />}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
