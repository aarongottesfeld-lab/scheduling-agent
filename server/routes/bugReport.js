// routes/bugReport.js — bug report submission
//
// POST /bug-report
//   requireAuth
//   Accepts: { category, message, page_url }
//   Validates category against whitelist, then inserts to bug_reports table.

'use strict';

const VALID_CATEGORIES = new Set([
  'Something broke',
  'Wrong info in itinerary',
  'Bad suggestion quality',
  'Other',
]);

module.exports = function bugReportRouter(app, supabase, requireAuth) {

  app.post('/bug-report', requireAuth, async (req, res) => {
    const { category, message, page_url } = req.body;

    if (!category || !VALID_CATEGORIES.has(category)) {
      return res.status(400).json({
        error: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}`,
      });
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const cleanMessage = message.trim().slice(0, 5000);
    const cleanUrl     = typeof page_url === 'string' ? page_url.slice(0, 500) : null;

    const { error: insertErr } = await supabase
      .from('bug_reports')
      .insert({
        user_id:  req.userId,
        category,
        message:  cleanMessage,
        page_url: cleanUrl,
      });

    if (insertErr) {
      console.error('[bug-report] insert error:', insertErr.message);
      return res.status(500).json({ error: 'Could not save bug report.' });
    }

    res.json({ success: true });
  });

};
