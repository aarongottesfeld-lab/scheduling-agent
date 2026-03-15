// routes/notifications.js
module.exports = function notificationsRouter(app, supabase, requireAuth) {

  // POST /push/register — store FCM token for this user
  app.post('/push/register', requireAuth, async (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.length > 500) {
      return res.status(400).json({ error: 'Invalid token.' });
    }
    try {
      // Upsert: one active token per user. If the user re-grants permission on a new
      // device or after clearing site data, this overwrites the old token rather than
      // accumulating stale entries.
      const { error } = await supabase
        .from('push_subscriptions')
        .upsert(
          { user_id: req.userId, token, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' }
        );
      if (error) {
        console.error('[push] register failed:', error.message);
        return res.status(500).json({ error: 'Could not register push token.' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[push] register threw:', err.message);
      res.status(500).json({ error: 'Could not register push token.' });
    }
  });

  // GET /notifications — list unread + recent read (last 30)
  app.get('/notifications', requireAuth, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('notifications')
        .select('id, type, title, body, data, read, action_url, ref_id, created_at')
        .eq('user_id', req.userId)
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) return res.status(500).json({ error: 'Could not fetch notifications.' });
      res.json({ notifications: data || [], unreadCount: (data || []).filter(n => !n.read).length });
    } catch (err) {
      console.error('GET /notifications failed:', err.message);
      res.status(500).json({ error: 'Could not fetch notifications.' });
    }
  });

  // POST /notifications/:id/read — mark one as read
  app.post('/notifications/:id/read', requireAuth, async (req, res) => {
    try {
      const { error } = await supabase.from('notifications')
        .update({ read: true })
        .eq('id', req.params.id)
        .eq('user_id', req.userId); // scope to owner — prevents marking another user's notification read
      if (error) {
        console.error('POST /notifications/:id/read failed:', error.message);
        return res.status(500).json({ error: 'Could not mark notification as read.' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /notifications/:id/read threw:', err.message);
      res.status(500).json({ error: 'Could not mark notification as read.' });
    }
  });

  // POST /notifications/read-all — mark all as read
  app.post('/notifications/read-all', requireAuth, async (req, res) => {
    try {
      const { error } = await supabase.from('notifications')
        .update({ read: true })
        .eq('user_id', req.userId)
        .eq('read', false);
      if (error) {
        console.error('POST /notifications/read-all failed:', error.message);
        return res.status(500).json({ error: 'Could not mark notifications as read.' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /notifications/read-all threw:', err.message);
      res.status(500).json({ error: 'Could not mark notifications as read.' });
    }
  });
};
