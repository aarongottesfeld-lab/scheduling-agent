#!/usr/bin/env node
// scripts/backfill-founder-friends.js — one-shot backfill of the founder welcome
// friend request to all onboarded users who have not yet received one.
//
// Usage:
//   node server/scripts/backfill-founder-friends.js           # writes for real
//   node server/scripts/backfill-founder-friends.js --dry-run # prints what it would do
//
// Reads SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FOUNDER_USER_ID from server/.env.
// Idempotent — safe to re-run.
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { sendFounderFriendRequest, backfillFounderRequests } = require('../services/founderFriend');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const founder = process.env.FOUNDER_USER_ID;
  if (!url || !key) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
  if (!founder)     { console.error('Missing FOUNDER_USER_ID'); process.exit(1); }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  if (dryRun) {
    const { data: candidates, error } = await supabase
      .from('profiles')
      .select('id, full_name, username')
      .not('onboarding_completed_at', 'is', null)
      .is('welcome_friend_request_sent_at', null);
    if (error) { console.error('Dry-run query failed:', error.message); process.exit(1); }

    // Filter out anyone who would be skipped by the in-flight guards.
    const filtered = [];
    for (const c of candidates || []) {
      if (c.id === founder) continue;
      const a = await supabase.from('friendships').select('id').eq('user_id', founder).eq('friend_id', c.id).maybeSingle();
      if (a.data) continue;
      const b = await supabase.from('friendships').select('id').eq('user_id', c.id).eq('friend_id', founder).maybeSingle();
      if (b.data) continue;
      filtered.push(c);
    }
    console.log(`DRY RUN: ${filtered.length} request(s) would be sent.`);
    filtered.forEach(c => console.log(`  - ${c.id}  ${c.full_name || ''} (@${c.username || '?'})`));
    return;
  }

  console.log('Running backfillFounderRequests...');
  const summary = await backfillFounderRequests(supabase);
  console.log('Summary:', JSON.stringify(summary, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
