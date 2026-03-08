// routes/notifications.js
module.exports = function notificationsRouter(app, supabase, requireAuth) {

  // GET /notifications — list unread + recent read (last 30)
  app.get('/notifications', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, body, read, action_url, ref_id, created_at')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) return res.status(500).json({ error: 'Could not fetch notifications.' });
    res.json({ notifications: data || [], unreadCount: (data || []).filter(n => !n.read).length });
  });

  // POST /notifications/:id/read — mark one as read
  app.post('/notifications/:id/read', requireAuth, async (req, res) => {
    await supabase.from('notifications')
      .update({ read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.userId);
    res.json({ ok: true });
  });

  // POST /notifications/read-all — mark all as read
  app.post('/notifications/read-all', requireAuth, async (req, res) => {
    await supabase.from('notifications')
      .update({ read: true })
      .eq('user_id', req.userId)
      .eq('read', false);
    res.json({ ok: true });
  });
};
