// routes/schedule.js — scheduling engine
// POST /schedule/suggest      — AI suggestion engine (main feature)
// GET  /schedule/itineraries  — list user's itineraries
// GET  /schedule/itinerary/:id
// POST /schedule/itinerary/:id/send
// POST /schedule/itinerary/:id/decline
// POST /schedule/itinerary/:id/reroll
// POST /schedule/confirm

'use strict';
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// Use Haiku in dev (cheap, fast for testing), Sonnet in production (quality suggestions)
const IS_PROD = process.env.NODE_ENV === 'production';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL
  || (IS_PROD ? 'claude-sonnet-4-5' : 'claude-haiku-4-5-20251001');

/* ── Helpers ──────────────────────────────────────────────────────── */

function createOAuth2Client(tokens) {
  const c = new (require('googleapis').google.auth.OAuth2)(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (tokens) c.setCredentials(tokens);
  return c;
}

/** Fetch busy slots for a user. Uses real Google Calendar if tokens exist,
 *  otherwise falls back to mock_busy_slots from the profile row (test users). */
async function fetchBusy(session, startISO, endISO, supabase, userId) {
  // Real calendar path
  if (session?.tokens?.access_token) {
    try {
      const auth = createOAuth2Client(session.tokens);
      const calendar = google.calendar({ version: 'v3', auth });
      const res = await calendar.freebusy.query({
        requestBody: {
          timeMin: startISO,
          timeMax: endISO,
          items: [{ id: 'primary' }],
        },
      });
      return res.data.calendars?.primary?.busy || [];
    } catch (e) {
      console.warn('fetchBusy (Google) failed:', e.message);
    }
  }
  // Mock fallback for test users (no OAuth tokens)
  if (userId && supabase) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('mock_busy_slots')
        .eq('id', userId)
        .single();
      const slots = data?.mock_busy_slots || [];
      const start = new Date(startISO);
      const end   = new Date(endISO);
      return slots
        .filter(s => new Date(s.end) > start && new Date(s.start) < end)
        .map(s => ({ start: s.start, end: s.end }));
    } catch (e) {
      console.warn('fetchBusy (mock) failed:', e.message);
    }
  }
  return [];
}

/** Parse a time-of-day filter into [startHour, endHour] (24h). */
function timeOfDayHours(tod) {
  if (!tod || tod.type === 'any') return [8, 23];
  if (tod.type === 'morning')   return [8, 12];
  if (tod.type === 'afternoon') return [12, 17];
  if (tod.type === 'evening')   return [17, 23];
  if (tod.type === 'custom') {
    const [timePart, ampm] = tod.time.split(' ');
    let [h, m] = timePart.split(':').map(Number);
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    const winHours = Math.ceil((Number(tod.windowMinutes) || 60) / 60);
    return [Math.max(0, h - winHours), Math.min(23, h + winHours)];
  }
  return [8, 23];
}

/** Generate candidate 2-hour windows across a date range that don't overlap busy slots. */
function findFreeWindows(busyA, busyB, startDate, endDate, todFilter, maxWindows = 20) {
  const [startHour, endHour] = timeOfDayHours(todFilter);
  const windows = [];
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T23:59:59');

  while (cur <= end && windows.length < maxWindows) {
    for (let h = startHour; h <= endHour - 2; h += 1) {
      const wStart = new Date(cur);
      wStart.setHours(h, 0, 0, 0);
      const wEnd = new Date(cur);
      wEnd.setHours(h + 2, 0, 0, 0);

      const overlaps = (slots) => slots.some(s => {
        const sStart = new Date(s.start);
        const sEnd = new Date(s.end);
        return sStart < wEnd && sEnd > wStart;
      });

      if (!overlaps(busyA) && !overlaps(busyB)) {
        windows.push({ start: wStart.toISOString(), end: wEnd.toISOString() });
        if (windows.length >= maxWindows) break;
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  return windows;
}

/** Build the Claude prompt for generating itinerary suggestions. */
function buildSuggestPrompt({ userA, userB, freeWindows, contextPrompt, maxTravelMinutes }) {
  const windowList = freeWindows.slice(0, 15).map(w => {
    const s = new Date(w.start);
    return `- ${s.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })} ${s.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}–${new Date(w.end).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
  }).join('\n');

  return `You are Rendezvous, a NYC activity planner. Generate exactly 3 itinerary suggestions for two people to meet up.

PERSON A: ${userA.name}
Location: ${userA.location || 'NYC'}
Into: ${(userA.activity_preferences || []).join(', ') || 'general NYC activities'}
Dietary: ${(userA.dietary_restrictions || []).join(', ') || 'none'}
Mobility: ${(userA.mobility_restrictions || []).join(', ') || 'none'}

PERSON B: ${userB.name}
Location: ${userB.location || 'NYC'}
Into: ${(userB.activity_preferences || []).join(', ') || 'general NYC activities'}
Dietary: ${(userB.dietary_restrictions || []).join(', ') || 'none'}
Mobility: ${(userB.mobility_restrictions || []).join(', ') || 'none'}

AVAILABLE TIME WINDOWS (use one per suggestion):
${windowList || 'Flexible — pick reasonable times in the next 2 weeks'}

MAX TRAVEL TIME: ${maxTravelMinutes ? maxTravelMinutes + ' minutes each way' : 'no limit'}

${contextPrompt ? `ADDITIONAL CONTEXT FROM USER: ${contextPrompt}` : ''}

Return ONLY a JSON object (no markdown, no preamble) in this exact shape:
{
  "suggestions": [
    {
      "id": "s1",
      "title": "Short catchy title",
      "date": "YYYY-MM-DD",
      "time": "7:00 PM",
      "durationMinutes": 120,
      "neighborhood": "West Village",
      "venues": [
        { "name": "Venue Name", "type": "bar|restaurant|activity|venue", "address": "123 Main St, New York, NY" }
      ],
      "narrative": "2-3 sentence description of why this works for both people",
      "estimatedTravelA": "15 min",
      "estimatedTravelB": "20 min",
      "tags": ["cocktails", "rooftop"]
    }
  ]
}

Rules:
- All venues must be real, currently open NYC establishments
- Respect dietary restrictions — if someone is vegetarian, all dining venues must have strong veggie options
- Respect mobility restrictions
- Spread suggestions across different vibes (e.g. chill, active, social)
- Use different time windows for each suggestion when possible
- Keep narrative warm and personal, referencing their shared interests`;
}

module.exports = function scheduleRouter(app, supabase, requireAuth, userSessions) {

  /* ── POST /schedule/suggest ──────────────────────────────── */
  app.post('/schedule/suggest', requireAuth, async (req, res) => {
    const { targetUserId, startDate, endDate, timeOfDay, maxTravelMinutes, contextPrompt } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required.' });

    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end   = endDate   || (() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; })();

    // Load both profiles
    const [profileARes, profileBRes] = await Promise.all([
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', req.userId).single(),
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', targetUserId).single(),
    ]);

    const userA = { name: req.userSession.name || 'User A', ...profileARes.data };
    const userB = { name: profileBRes.data?.full_name || 'Friend', ...profileBRes.data };

    // Fetch calendar availability for both users
    const startISO = new Date(start + 'T00:00:00').toISOString();
    const endISO   = new Date(end   + 'T23:59:59').toISOString();

    // Get friend's session for calendar access (may not be logged in — graceful fallback)
    const friendSession = [...(userSessions?.entries() || [])].find(([, s]) => s.supabaseId === targetUserId)?.[1];

    const [busyA, busyB] = await Promise.all([
      fetchBusy(req.userSession,  startISO, endISO, supabase, req.userId),
      fetchBusy(friendSession,    startISO, endISO, supabase, targetUserId),
    ]);

    const freeWindows = findFreeWindows(busyA, busyB, start, end, timeOfDay);

    // Call Claude
    const prompt = buildSuggestPrompt({ userA, userB, freeWindows, contextPrompt, maxTravelMinutes });
    let suggestions;
    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text || '{}';
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
      suggestions = parsed.suggestions || [];
    } catch (e) {
      console.error('Claude suggestion error:', e.message, e.stack?.split('\n')[1]);
      // Never expose internal API errors (billing, keys, etc.) to the client
      return res.status(500).json({ error: 'Could not generate suggestions. Please try again.' });
    }

    // Persist itinerary
    const { data: itinerary, error: insertErr } = await supabase
      .from('itineraries')
      .insert({
        organizer_id:   req.userId,
        attendee_id:    targetUserId,
        organizer_status: 'pending',
        attendee_status:  'pending',
        suggestions:    suggestions,
        reroll_count:   0,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('Itinerary insert error:', insertErr.message);
      return res.status(500).json({ error: 'Could not save itinerary.' });
    }

    res.json({ itineraryId: itinerary.id, suggestions });
  });

  /* ── GET /schedule/itineraries ───────────────────────────── */
  app.get('/schedule/itineraries', requireAuth, async (req, res) => {
    const filter = req.query.filter; // 'waiting' | 'upcoming' | undefined = all

    let query = supabase
      .from('itineraries')
      .select('id, organizer_id, attendee_id, organizer_status, attendee_status, suggestions, locked_at, created_at, reroll_count')
      .or(`organizer_id.eq.${req.userId},attendee_id.eq.${req.userId}`)
      .order('created_at', { ascending: false })
      .limit(50);

    if (filter === 'waiting')  query = query.is('locked_at', null);
    if (filter === 'upcoming') query = query.not('locked_at', 'is', null);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Could not fetch itineraries.' });

    // Enrich with profile names
    const ids = [...new Set((data || []).flatMap(i => [i.organizer_id, i.attendee_id]))];
    const { data: profiles } = await supabase.from('profiles').select('id,full_name').in('id', ids);
    const nameMap = Object.fromEntries((profiles || []).map(p => [p.id, p.full_name]));

    res.json({
      itineraries: (data || []).map(i => ({
        ...i,
        organizerName: nameMap[i.organizer_id] || 'Unknown',
        attendeeName:  nameMap[i.attendee_id]  || 'Unknown',
        isOrganizer: i.organizer_id === req.userId,
      })),
    });
  });

  /* ── GET /schedule/itinerary/:id ─────────────────────────── */
  app.get('/schedule/itinerary/:id', requireAuth, async (req, res) => {
    const { data, error } = await supabase
      .from('itineraries')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Itinerary not found.' });
    if (data.organizer_id !== req.userId && data.attendee_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized.' });
    }

    const ids = [data.organizer_id, data.attendee_id];
    const { data: profiles } = await supabase.from('profiles').select('id,full_name,location,avatar_url').in('id', ids);
    const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

    res.json({
      ...data,
      organizer: profileMap[data.organizer_id] || { id: data.organizer_id, full_name: 'Unknown' },
      attendee:  profileMap[data.attendee_id]  || { id: data.attendee_id,  full_name: 'Unknown' },
      isOrganizer: data.organizer_id === req.userId,
    });
  });

  /* ── POST /schedule/confirm ──────────────────────────────── */
  app.post('/schedule/confirm', requireAuth, async (req, res) => {
    const { itineraryId, suggestionId } = req.body;
    if (!itineraryId || !suggestionId) return res.status(400).json({ error: 'itineraryId and suggestionId required.' });

    const { data: itin } = await supabase.from('itineraries').select('*').eq('id', itineraryId).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });

    const isOrganizer = itin.organizer_id === req.userId;
    const isAttendee  = itin.attendee_id  === req.userId;
    if (!isOrganizer && !isAttendee) return res.status(403).json({ error: 'Not authorized.' });

    const statusField = isOrganizer ? 'organizer_status' : 'attendee_status';
    const otherStatus = isOrganizer ? itin.attendee_status : itin.organizer_status;

    const updates = {
      [statusField]: 'accepted',
      selected_suggestion_id: suggestionId,
    };

    // If both sides have now accepted the same suggestion — lock it
    if (otherStatus === 'accepted' && itin.selected_suggestion_id === suggestionId) {
      updates.locked_at = new Date().toISOString();
    }

    const { data: updated } = await supabase.from('itineraries').update(updates).eq('id', itineraryId).select().single();
    res.json({ itinerary: updated, locked: !!updated?.locked_at });
  });

  /* ── POST /schedule/itinerary/:id/send ───────────────────── */
  app.post('/schedule/itinerary/:id/send', requireAuth, async (req, res) => {
    const { data: itin } = await supabase.from('itineraries').select('organizer_id,organizer_status').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId) return res.status(403).json({ error: 'Only the organizer can send.' });

    await supabase.from('itineraries').update({ organizer_status: 'sent' }).eq('id', req.params.id);
    res.json({ ok: true });
  });

  /* ── POST /schedule/itinerary/:id/decline ────────────────── */
  app.post('/schedule/itinerary/:id/decline', requireAuth, async (req, res) => {
    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });

    const field = itin.organizer_id === req.userId ? 'organizer_status' : 'attendee_status';
    await supabase.from('itineraries').update({ [field]: 'declined' }).eq('id', req.params.id);
    res.json({ ok: true });
  });

  /* ── POST /schedule/itinerary/:id/reroll ─────────────────── */
  app.post('/schedule/itinerary/:id/reroll', requireAuth, async (req, res) => {
    const { data: itin } = await supabase.from('itineraries').select('*').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });
    if (itin.locked_at) return res.status(400).json({ error: 'Cannot reroll a locked itinerary.' });
    if ((itin.reroll_count || 0) >= 3) return res.status(400).json({ error: 'Max 3 rerolls reached.' });

    const { contextPrompt, feedback } = req.body;

    const [profileARes, profileBRes] = await Promise.all([
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', itin.organizer_id).single(),
      supabase.from('profiles').select('id,full_name,location,activity_preferences,dietary_restrictions,mobility_restrictions').eq('id', itin.attendee_id).single(),
    ]);

    const userA = profileARes.data || {};
    const userB = profileBRes.data || {};

    const prompt = buildSuggestPrompt({
      userA: { ...userA, name: userA.full_name || 'User A' },
      userB: { ...userB, name: userB.full_name || 'User B' },
      freeWindows: [],
      contextPrompt: [contextPrompt, feedback ? `Previous suggestions feedback: ${feedback}` : ''].filter(Boolean).join('. '),
      maxTravelMinutes: null,
    });

    let suggestions;
    try {
      const msg = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });
      const raw = msg.content[0]?.text || '{}';
      suggestions = JSON.parse(raw.replace(/```json|```/g, '').trim()).suggestions || [];
    } catch (e) {
      console.error('Claude reroll error:', e.message);
      return res.status(500).json({ error: 'Could not generate new suggestions. Please try again.' });
    }

    const { data: updated } = await supabase.from('itineraries')
      .update({ suggestions, reroll_count: (itin.reroll_count || 0) + 1, organizer_status: 'pending', attendee_status: 'pending', selected_suggestion_id: null })
      .eq('id', req.params.id)
      .select().single();

    res.json({ itinerary: updated });
  });

  /* ── POST /schedule/itinerary/:id/changelog ──────────────── */
  app.post('/schedule/itinerary/:id/changelog', requireAuth, async (req, res) => {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required.' });

    const { data: itin } = await supabase.from('itineraries').select('organizer_id,attendee_id,changelog').eq('id', req.params.id).single();
    if (!itin) return res.status(404).json({ error: 'Itinerary not found.' });
    if (itin.organizer_id !== req.userId && itin.attendee_id !== req.userId) return res.status(403).json({ error: 'Not authorized.' });

    const entry = { userId: req.userId, message: message.trim(), ts: new Date().toISOString() };
    const changelog = [...(itin.changelog || []), entry];

    await supabase.from('itineraries').update({ changelog }).eq('id', req.params.id);
    res.json({ ok: true, entry });
  });
};
