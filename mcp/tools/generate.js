// mcp/tools/generate.js — create_itinerary_request, get_itinerary_job,
//   reroll_itinerary, respond_to_itinerary, lock_itinerary
'use strict';

const { z } = require('zod');
const crypto = require('crypto');
const { dispatchNotification } = require('../utils/notificationDispatch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INJECTION_RE = /\b(ignore\s+(previous|all|prior)\s+(instructions?|prompts?|context)|system\s*:|assistant\s*:|<\s*\/?\s*(system|assistant|user|prompt)\s*>|disregard\s+(the\s+)?(above|previous|prior)|you\s+are\s+now|new\s+instructions?|override\s+(the\s+)?(above|previous)|forget\s+(everything|all)|jailbreak|do\s+anything\s+now|DAN\b)/gim;

function sanitize(text, max = 500) {
  if (!text || typeof text !== 'string') return '';
  return text.replace(INJECTION_RE, '[removed]').trim().slice(0, max);
}

function registerTools(server, supabase, config, userId) {

  // ── create_itinerary_request ──────────────────────────────────────────
  server.tool(
    'create_itinerary_request',
    'Create a new 1-on-1 itinerary request with a friend. Generation is async — poll get_itinerary_job for results.',
    {
      friend_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      date_range_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      date_range_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      time_of_day: z.enum(['morning', 'afternoon', 'evening', 'any']).optional().default('any'),
      context_prompt: z.string().max(500).optional().describe('What kind of activity or vibe the user wants'),
      max_travel_minutes: z.number().int().min(5).max(120).optional(),
    },
    async ({ friend_id, date_range_start, date_range_end, time_of_day, context_prompt, max_travel_minutes }) => {
      // Verify friendship
      const { data: friendship } = await supabase
        .from('friendships')
        .select('status')
        .eq('user_id', userId)
        .eq('friend_id', friend_id)
        .eq('status', 'accepted')
        .maybeSingle();

      if (!friendship) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not friends with this user.' }) }] };
      }

      const safeContext = sanitize(context_prompt);

      // Insert itinerary row
      const { data: itin, error } = await supabase
        .from('itineraries')
        .insert({
          organizer_id: userId,
          attendee_id: friend_id,
          organizer_status: 'pending',
          attendee_status: 'pending',
          date_range_start,
          date_range_end,
          time_of_day: time_of_day ? { type: time_of_day } : { type: 'any' },
          context_prompt: safeContext,
          max_travel_minutes: max_travel_minutes || null,
          suggestions: [],
          reroll_count: 0,
        })
        .select('id')
        .single();

      if (error) {
        console.error('[mcp/generate] create itinerary error:', error.message);
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not create itinerary.' }) }] };
      }

      // Kick off generation asynchronously via internal HTTP call to the main server.
      // This avoids duplicating the complex generation logic.
      triggerGeneration(itin.id, config).catch(err => {
        console.error('[mcp/generate] async generation failed:', err.message);
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ job_id: itin.id, status: 'generating' }),
        }],
      };
    }
  );

  // ── get_itinerary_job ─────────────────────────────────────────────────
  server.tool(
    'get_itinerary_job',
    'Check the status of an itinerary generation job. Poll every 3-5s until status is not "generating".',
    {
      job_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
    },
    async ({ job_id }) => {
      const { data: itin, error } = await supabase
        .from('itineraries')
        .select('id, suggestions, organizer_status, organizer_id, attendee_id')
        .eq('id', job_id)
        .single();

      if (error || !itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Job not found.' }) }] };
      }

      if (itin.organizer_id !== userId && itin.attendee_id !== userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }

      let status;
      if (!itin.suggestions || itin.suggestions.length === 0) {
        status = 'generating';
      } else {
        status = 'ready';
      }

      const result = { status };
      if (status === 'ready') {
        result.suggestion_count = itin.suggestions.length;
      }

      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
  );

  // ── reroll_itinerary ──────────────────────────────────────────────────
  server.tool(
    'reroll_itinerary',
    'Regenerate suggestions for an itinerary. Async — poll get_itinerary_job for results.',
    {
      itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      feedback: z.string().max(500).optional().describe('What to change about the suggestions'),
    },
    async ({ itinerary_id, feedback }) => {
      const { data: itin } = await supabase
        .from('itineraries')
        .select('id, organizer_id, attendee_id, locked_at')
        .eq('id', itinerary_id)
        .single();

      if (!itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Itinerary not found.' }) }] };
      }
      if (itin.organizer_id !== userId && itin.attendee_id !== userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }
      if (itin.locked_at) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Cannot reroll a locked itinerary.' }) }] };
      }

      // Clear suggestions to signal "generating"
      await supabase.from('itineraries')
        .update({ suggestions: [] })
        .eq('id', itinerary_id);

      // Trigger reroll asynchronously
      triggerReroll(itinerary_id, sanitize(feedback), config).catch(err => {
        console.error('[mcp/generate] async reroll failed:', err.message);
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ job_id: itinerary_id, status: 'generating' }),
        }],
      };
    }
  );

  // ── respond_to_itinerary ──────────────────────────────────────────────
  server.tool(
    'respond_to_itinerary',
    'Accept or decline an itinerary suggestion',
    {
      itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      response: z.enum(['accepted', 'declined']),
      selected_suggestion_index: z.number().int().min(0).optional().describe('Required when accepting — index of the chosen suggestion'),
    },
    async ({ itinerary_id, response, selected_suggestion_index }) => {
      const { data: itin } = await supabase
        .from('itineraries')
        .select('*')
        .eq('id', itinerary_id)
        .single();

      if (!itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Itinerary not found.' }) }] };
      }
      if (itin.organizer_id !== userId && itin.attendee_id !== userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Not authorized.' }) }] };
      }

      const isOrganizer = itin.organizer_id === userId;
      const statusField = isOrganizer ? 'organizer_status' : 'attendee_status';
      const otherUserId = isOrganizer ? itin.attendee_id : itin.organizer_id;

      if (response === 'declined') {
        await supabase.from('itineraries')
          .update({ [statusField]: 'declined' })
          .eq('id', itinerary_id);

        // Notify other party
        const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', userId).single();
        await dispatchNotification(supabase, {
          userId: otherUserId,
          type: 'itinerary_declined',
          title: `${profile?.full_name || 'Someone'} declined the plan`,
          body: 'They passed on the itinerary. You can reroll or start fresh.',
          actionUrl: `/schedule/${itinerary_id}`,
        });

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, locked: false }) }] };
      }

      // Accepting
      if (selected_suggestion_index === undefined || selected_suggestion_index === null) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'selected_suggestion_index is required when accepting.' }) }] };
      }

      const suggestions = itin.suggestions || [];
      if (selected_suggestion_index < 0 || selected_suggestion_index >= suggestions.length) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid suggestion index.' }) }] };
      }

      const selectedSuggestion = suggestions[selected_suggestion_index];
      const update = {
        [statusField]: 'accepted',
        selected_suggestion_id: selectedSuggestion.id,
      };

      // Let the DB trigger (itineraries_lock_check) handle locked_at
      await supabase.from('itineraries')
        .update(update)
        .eq('id', itinerary_id);

      // Re-fetch to check if the trigger set locked_at
      const { data: refreshed } = await supabase
        .from('itineraries')
        .select('locked_at')
        .eq('id', itinerary_id)
        .single();

      const locked = !!refreshed?.locked_at;

      // Notify other party
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', userId).single();
      const notifType = locked ? 'itinerary_locked' : 'itinerary_accepted';
      const notifTitle = locked ? 'Plans confirmed!' : `${profile?.full_name || 'Someone'} accepted the plan`;
      const notifBody = locked
        ? `Your plans are locked in. Check the itinerary for details.`
        : `${profile?.full_name || 'Someone'} accepted the itinerary. Review and confirm to lock it in.`;

      await dispatchNotification(supabase, {
        userId: otherUserId,
        type: notifType,
        title: notifTitle,
        body: notifBody,
        actionUrl: `/schedule/${itinerary_id}`,
      });

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, locked }) }] };
    }
  );

  // ── lock_itinerary ────────────────────────────────────────────────────
  server.tool(
    'lock_itinerary',
    'Lock an itinerary by selecting a suggestion (organizer action). Creates calendar events if possible.',
    {
      itinerary_id: z.string().regex(UUID_RE, 'Must be a valid UUID'),
      selected_suggestion_index: z.number().int().min(0),
    },
    async ({ itinerary_id, selected_suggestion_index }) => {
      const { data: itin } = await supabase
        .from('itineraries')
        .select('*')
        .eq('id', itinerary_id)
        .single();

      if (!itin) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Itinerary not found.' }) }] };
      }
      if (itin.organizer_id !== userId) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Only the organizer can lock.' }) }] };
      }
      if (itin.locked_at) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Already locked.' }) }] };
      }

      const suggestions = itin.suggestions || [];
      if (selected_suggestion_index < 0 || selected_suggestion_index >= suggestions.length) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid suggestion index.' }) }] };
      }

      const selectedSuggestion = suggestions[selected_suggestion_index];
      const now = new Date().toISOString();

      await supabase.from('itineraries')
        .update({
          organizer_status: 'accepted',
          selected_suggestion_id: selectedSuggestion.id,
          locked_at: now,
        })
        .eq('id', itinerary_id);

      // Attempt calendar event creation (best-effort)
      let calendarEventId = null;
      if (config.getSessionBySupabaseId) {
        try {
          const { createCalendarEventForUser } = require('../../server/utils/calendarUtils');
          const [orgSession, attSession] = await Promise.all([
            config.getSessionBySupabaseId(itin.organizer_id),
            config.getSessionBySupabaseId(itin.attendee_id),
          ]);
          const { data: profiles } = await supabase.from('profiles').select('id, full_name, email').in('id', [itin.organizer_id, itin.attendee_id]);
          const profileMap = Object.fromEntries((profiles || []).map(p => [p.id, p]));

          if (orgSession?.tokens?.access_token) {
            const result = await createCalendarEventForUser({
              session: orgSession,
              suggestion: selectedSuggestion,
              organizer: profileMap[itin.organizer_id] || { email: '', full_name: 'Organizer' },
              attendee: profileMap[itin.attendee_id] || { email: '', full_name: 'Attendee' },
              itineraryId: itinerary_id,
              supabase,
              userId: itin.organizer_id,
            });
            if (result?.id) {
              calendarEventId = result.id;
              await supabase.from('itineraries')
                .update({ calendar_event_id: result.id, calendar_event_url: result.htmlLink || null })
                .eq('id', itinerary_id);
            }
          }
        } catch (e) {
          console.warn('[mcp/generate] calendar event creation failed:', e.message);
        }
      }

      // Notify attendee
      const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', userId).single();
      await dispatchNotification(supabase, {
        userId: itin.attendee_id,
        type: 'itinerary_locked',
        title: 'Plans confirmed!',
        body: `${profile?.full_name || 'Someone'} locked in the plans. Check the itinerary for details.`,
        actionUrl: `/schedule/${itinerary_id}`,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            locked: true,
            calendar_event_id: calendarEventId,
          }),
        }],
      };
    }
  );
}

/**
 * Trigger suggestion generation via the main server's internal API.
 * The main server runs the full AI generation pipeline and updates the itinerary row directly.
 */
async function triggerGeneration(itineraryId, config) {
  const url = `${process.env.RENDEZVOUS_API_URL}/internal/schedule/trigger-suggest`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RENDEZVOUS_API_KEY}`,
      },
      body: JSON.stringify({ itinerary_id: itineraryId, source: 'mcp' }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[mcp/generate] triggerGeneration HTTP ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error('[mcp/generate] triggerGeneration failed:', err.message);
  }
}

async function triggerReroll(itineraryId, feedback, config) {
  const url = `${process.env.RENDEZVOUS_API_URL}/internal/schedule/trigger-reroll`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RENDEZVOUS_API_KEY}`,
      },
      body: JSON.stringify({ itinerary_id: itineraryId, feedback, source: 'mcp' }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[mcp/generate] triggerReroll HTTP ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error('[mcp/generate] triggerReroll failed:', err.message);
  }
}

module.exports = { registerTools };
