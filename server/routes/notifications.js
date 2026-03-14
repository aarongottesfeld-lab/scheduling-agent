// routes/notifications.js
module.exports = function notificationsRouter(app, supabase, requireAuth) {

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
