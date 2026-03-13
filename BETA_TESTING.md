# Rendezvous — Beta Testing
Last updated: March 14, 2026

This file documents the beta testing plan, tester management process, feedback links,
and context for analyzing results. Reference this file when reviewing feedback or
onboarding new testers in future sessions.

---

## Current Status

Beta is open. First batch of real users being recruited from Aaron's personal network.
App is live at https://rendezvous-gamma.vercel.app

Google OAuth is in testing mode — users must be added to the allowlist before they
can sign in. Maximum 100 test users before Google OAuth verification is required.

---

## Feedback Links

**Feedback form (send to testers):**
https://docs.google.com/forms/d/e/1FAIpQLSeAk1O_pPiJh376XybMTIWFnj0kKczYOzU2AeRoIsmrJbRFBw/viewform

**Responses spreadsheet (Aaron only):**
https://docs.google.com/spreadsheets/d/1iZFVKSu86gD9j4JPPxuZpeNtFOamVpcLAOS6BeRtHk4/edit

Form questions:
1. Overall experience rating (1–5 linear scale)
2. What did you use the app for? (multiple choice)
3. How good were the itinerary suggestions? (1–5 linear scale)
4. Did anything break or confuse you? (multiple choice)
5. Describe what happened (paragraph — optional)
6. How likely are you to use this again? (1–5 linear scale)
7. What's the one thing you'd most want fixed or added? (paragraph)
8. Name / how to reach you for follow-up (short answer — optional)

---

## Tester Management Process

### Adding a new tester (per person)
1. Confirm they want to participate and get their Gmail address
2. Go to Google Cloud Console → APIs & Services → OAuth consent screen → Test users
3. Add their Gmail address to the test users list
4. Send them the app link + feedback form + one-liner setup note

### Outreach message (template)
> "Hey — I've been building a scheduling app called Rendezvous. It connects to your
> Google Calendar, finds when you're both free, and generates an itinerary for you.
> Would love for you to try it and tell me what you think. I'll send you the link +
> a quick setup note once you're in."

### Setup note (send after adding to Google Console)
> App: https://rendezvous-gamma.vercel.app
> Feedback: [form link above]
> One thing: connect your Google Calendar when prompted — that's what makes it work.

### Tester spreadsheet
Maintain a separate private spreadsheet (not committed to the repo) with:
- Name
- Gmail address
- Date added to Google Console
- Notes (dietary restrictions they have, activity interests, etc.)
  — useful for cross-referencing if suggestion quality bugs come up

---

## Feedback Analysis Plan

After collecting responses, bring the spreadsheet into a Claude.ai session to:
1. Identify patterns in Q3 (suggestion quality) and Q7 (top requested fix/feature)
2. Cross-reference with PostHog data:
   - Funnel: pageview /onboarding → onboarding_completed → suggestion_generated → itinerary_locked
   - Reroll rate: high reroll_count on suggestion_generated = output quality issue
   - Drop-off points: where are people leaving without completing a flow?
3. Prioritize fixes into: blocking bugs / output quality / UX polish / feature requests

PostHog project is connected to this Claude.ai account — can query live event data directly.

---

## Beta Plan — Order of Operations

1. Send call to action to friends network → get list of opt-ins
2. Add each tester to Google Cloud Console (OAuth test users)
3. Send app link + feedback form + setup note
4. Collect responses (target: 2 weeks of passive feedback)
5. Analyze feedback + PostHog data with Claude → produce prioritized improvement plan
6. Implement top fixes (Claude Code)
7. Host bug bash pizza party with subset of engaged testers for structured QA session

---

## Bug Bash Pizza Party

Format: in-person session with 4–8 engaged testers
Goal: structured QA on the flows that are hardest to test solo (group mode, attendee flow,
negotiation state machine)
What to prepare:
- Pre-create test accounts for anyone who doesn't have one
- Assign specific test scenarios per person (e.g. "you're the attendee, they're the organizer")
- Have a shared doc open for real-time bug logging
- Bring laptop to push hotfixes on the spot if needed

Suggested test scenarios for the session:
- Full 1:1 flow: create event → generate suggestions → send → accept → calendar invite created
- Attendee reroll: attendee suggests alternative → organizer re-evaluates → locks
- Group mode: 3+ people, quorum voting, one decline, one abstain
- Travel mode: multi-day event with destination set → day headers render correctly
- Onboarding: fresh account, complete all 3 steps, verify suggestions improve with profile data

---

## Key Context for Future Sessions

**Production URL:** https://rendezvous-gamma.vercel.app
**Supabase project:** bgeqxnrwrphbzenfrbdb (us-east-1)
**Vercel project:** prj_ik4LGx6e3UScndzVsIj7ul9BWglr, team: team_CzvVldNaVWk7WAkpXX99eu9K
**GitHub repo:** aarongottesfeld-lab/scheduling-agent (branch: main)

**Dev test users (seeded in Supabase, use dev switcher at localhost:3001/dev/users):**
- jamiec (11111111-1111-1111-1111-111111111111) — Upper West Side, sports fan
- mrivera (22222222-2222-2222-2222-222222222222) — Brooklyn Heights, Broadway/jazz/vegetarian
- tkim (33333333-3333-3333-3333-333333333333) — Midtown East, tennis/golf/concerts
- alexp (44444444-4444-4444-4444-444444444444) — Astoria, Mets/escape rooms/gluten-free

**Aaron's Supabase UUID:** b522125b-2698-4c74-bc24-a441754f1a12
**Aaron's onboarding_completed_at:** set manually (skipped onboarding as existing user)

**PostHog:** connected to Claude.ai account — can query live events directly in session
Key events instrumented: suggestion_generated, reroll_triggered, itinerary_locked,
friend_added, onboarding_completed, $pageview

**AI model config:**
- Dev (localhost): claude-haiku-4-5-20251001
- Prod (Vercel): claude-sonnet-4-5-20250929

**Session cookie:** rendezvous_session (HTTP-only, secure in prod, sameSite none prod / lax dev)
