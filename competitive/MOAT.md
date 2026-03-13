# Rendezvous — Competitive Moat

Last updated: March 2026

This file is intentionally separate from the core product roadmap and monetization
strategy. We're building Rendezvous out of passion, with the end user always first.
This document exists purely as a long-term reference — not a build directive.

---

## The honest baseline

The core mechanics are replicable. Any company with engineering resources can wire
together a calendar API, an LLM, and a maps API. The tech stack is not the moat.
The moat is what compounds over time as real users interact with the product.

---

## Where the edge actually lives

### 1. First-mover signal capture
The most immediate advantage. Every accepted itinerary, reroll, and decline is a
behavioral signal that a new competitor starting today won't have. The edge compounds
the longer we're live with real users before anyone else ships something comparable.
This is the primary reason to move fast and get to real users.

Relevant: structured telemetry is already wired (suggestion_telemetry JSONB on
itineraries). The data asset starts accumulating the moment the first real user
locks an itinerary.

### 2. Behavioral data flywheel
Stated preferences ("I like jazz") are weak signals. Revealed preferences — what
two people actually accepted together, what they skipped, what they rerolled —
are strong ones. Over time, a model informed by this pair-specific history becomes
genuinely hard to replicate without the same longitudinal data.

This is only valuable if:
- The data feeds back into better suggestions (not just stored)
- Enough users generate enough signal to differentiate

### 3. Social graph depth + private annotation layer
Once a user has added friends, customized their profile, written private notes about
a friend ("she always wants to stay below 14th St"), and built up itinerary history
with specific people — switching cost is real. None of that exports anywhere.

The `friend_annotations` table (private notes, shared interests, never visible to
the friend) is more strategically important than it looks. It's a layer of context
that exists nowhere else and can't be replicated by a competitor.

### 4. Brand trust
An app that touches your calendar, location, relationships, and dietary restrictions
needs to feel trustworthy. The "no ads, no sponsored placement" decision and the
privacy-first architecture are slow-compounding brand assets. A VC-backed competitor
with monetization pressure has a harder time making and keeping that promise.

### 5. Speed and taste
Built by someone who wants to use it, not assigned to a PM at a big platform.
That usually produces a better product. The window before a major player ships
something comparable is probably 18–24 months — being faster and more intentional
in that window creates users who become advocates.

---

## The real threat

Not dating apps or social platforms. The actual risk is Google or Apple shipping
something native to Calendar — distribution advantage that's very hard to counter.

The counter: they can suggest places, but they can't replicate the mutual planning
flow, the private annotation layer, or the pair-specific behavioral history. Those
are worth building intentionally and consistently.

---

## Things to keep watching

- [ ] Google Calendar AI features — any itinerary or "plans with contacts" integrations
- [ ] Apple Intelligence Calendar features (WWDC announcements)
- [ ] Dating apps adding post-match "what to do" features (Hinge, Bumble)
- [ ] Social platforms adding coordination layers (Snapchat, Instagram)
- [ ] Standalone competitors — anyone building specifically in this space

---

## What this means for the build (today)

Nothing changes. Build the best product for real users. The data flywheel and
social graph only become valuable once there are real people using the app — which
is why shipping matters more than moat-thinking right now.
