// NotificationBell.js — navbar bell with dropdown panel
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import client from '../utils/client';
import { getSupabaseId } from '../utils/auth';

function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts)) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}

const TYPE_ICON = {
  friend_request:      '👋',
  itinerary_invite:    '📅',
  itinerary_accepted:  '✅',
  itinerary_declined:  '❌',
  itinerary_reroll:    '🔄',
  group_invite:        '🎉',
  group_event_invite:  '📅',
};

export default function NotificationBell() {
  const navigate = useNavigate();
  const [open,          setOpen]          = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unread,        setUnread]        = useState(0);
  const [loading,       setLoading]       = useState(false);
  // Per-notification action busy state and error messages
  const [busyNotifId,   setBusyNotifId]   = useState(null);
  const [notifErrors,   setNotifErrors]   = useState({});
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.get('/notifications');
      setNotifications(res.data.notifications || []);
      setUnread(res.data.unreadCount || 0);
    } catch { /* silent — bell is non-critical */ }
    finally { setLoading(false); }
  }, []);

  // Poll every 30s for new notifications
  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  async function handleOpen() {
    setOpen(o => !o);
    if (!open) await load();
  }

  async function handleNotifClick(n) {
    if (!n.read) {
      await client.post(`/notifications/${n.id}/read`).catch(() => {});
      setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read: true } : x));
      setUnread(u => Math.max(0, u - 1));
    }
    setOpen(false);
    if (n.action_url) navigate(n.action_url);
  }

  async function markAllRead() {
    await client.post('/notifications/read-all').catch(() => {});
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnread(0);
  }

  /**
   * Accept or decline a group invite notification.
   * Calls PATCH /groups/:groupId/members/:userId, then removes the notification.
   */
  async function handleGroupInvite(notif, accept) {
    const groupId = notif.data?.group_id;
    const myId    = getSupabaseId();
    if (!groupId || !myId) return;

    setBusyNotifId(notif.id);
    setNotifErrors(prev => { const n = { ...prev }; delete n[notif.id]; return n; });

    try {
      await client.patch(`/groups/${groupId}/members/${myId}`, {
        status: accept ? 'active' : 'declined',
      });
      // Mark read and remove from list
      await client.post(`/notifications/${notif.id}/read`).catch(() => {});
      setNotifications(prev => prev.filter(x => x.id !== notif.id));
      setUnread(u => notif.read ? u : Math.max(0, u - 1));
    } catch (err) {
      setNotifErrors(prev => ({
        ...prev,
        [notif.id]: err.response?.data?.error || 'Action failed. Try again.',
      }));
    } finally {
      setBusyNotifId(null);
    }
  }

  return (
    <div style={{ position: 'relative' }} ref={panelRef}>
      <button
        className="notif-bell"
        onClick={handleOpen}
        aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ''}`}
        title="Notifications"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && (
          <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-panel__header">
            <span className="notif-panel__title">Notifications</span>
            {unread > 0 && (
              <button className="notif-panel__mark-all" onClick={markAllRead}>
                Mark all read
              </button>
            )}
          </div>

          {loading && notifications.length === 0 ? (
            <div className="notif-panel__empty"><div className="spinner" /></div>
          ) : notifications.length === 0 ? (
            <div className="notif-panel__empty">You're all caught up.</div>
          ) : (
            <ul className="notif-list">
              {notifications.map(n => {
                // Group invite — inline Accept / Decline buttons, no row navigation
                if (n.type === 'group_invite') {
                  const isBusy = busyNotifId === n.id;
                  return (
                    <li
                      key={n.id}
                      className={`notif-item${n.read ? '' : ' notif-item--unread'}`}
                    >
                      <span className="notif-item__icon">{TYPE_ICON.group_invite}</span>
                      <div className="notif-item__body">
                        <div className="notif-item__title">{n.title}</div>
                        {n.body && <div className="notif-item__sub">{n.body}</div>}
                        <div className="notif-item__time">{timeAgo(n.created_at)}</div>
                        {notifErrors[n.id] && (
                          <div style={{ color: 'var(--error)', fontSize: '0.78rem', marginTop: 4 }}>
                            {notifErrors[n.id]}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <button
                            className="btn btn--primary btn--sm"
                            disabled={isBusy}
                            onClick={e => { e.stopPropagation(); handleGroupInvite(n, true); }}
                          >
                            {isBusy ? '…' : 'Accept'}
                          </button>
                          <button
                            className="btn btn--ghost btn--sm"
                            disabled={isBusy}
                            onClick={e => { e.stopPropagation(); handleGroupInvite(n, false); }}
                          >
                            Decline
                          </button>
                        </div>
                      </div>
                      {!n.read && <span className="notif-item__dot" />}
                    </li>
                  );
                }

                // Default notification — row click marks read and navigates
                return (
                  <li
                    key={n.id}
                    className={`notif-item${n.read ? '' : ' notif-item--unread'}`}
                    onClick={() => handleNotifClick(n)}
                  >
                    <span className="notif-item__icon">{TYPE_ICON[n.type] || '🔔'}</span>
                    <div className="notif-item__body">
                      <div className="notif-item__title">{n.title}</div>
                      {n.body && <div className="notif-item__sub">{n.body}</div>}
                      <div className="notif-item__time">{timeAgo(n.created_at)}</div>
                    </div>
                    {!n.read && <span className="notif-item__dot" />}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="notif-panel__footer">
            <button className="notif-panel__see-all" onClick={() => { setOpen(false); navigate('/notifications'); }}>
              See all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
