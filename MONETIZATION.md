# Rendezvous — Monetization Ideas

Last updated: March 2026

This file is intentionally separate from the core product roadmap.
For thinking on competitive differentiation and long-term moat, see competitive/MOAT.md.
The initial build is product-first, user-first. These ideas exist for reference
when upkeep costs make revenue a real consideration — not before.

---

## Guiding principles (when the time comes)

- Monetization should be invisible or additive to the user experience — never extractive
- No sponsored content, promoted venues, or paid placement in suggestions
- Any paid tier should feel like "more of a good thing," not a gate on core value
- The free experience should remain genuinely useful

---

## Ideas (unranked, unscoped)

### Usage / rate limits
The most obvious lever. Free tier gets N itinerary generations and M rerolls per month.
Paid tier unlocks higher limits. Works best once users have enough engagement that they
actually hit the ceiling.

**Payment model decision (when ready):**
Two models are in play depending on what's being unlocked:

- **One-time purchase** (e.g. $0.99–$2.99): Best for ceiling removals — group size cap,
  higher reroll limits, feature unlocks that don't require ongoing delivery. Low friction,
  no ongoing commitment. A user who hits the group size cap once and pays to remove it
  is a better conversion than one asked to subscribe for the same benefit.
- **Subscription** (e.g. $X/month): Better for features that deliver ongoing value —
  concierge suggestions, booking support, priority AI generation, or a bundle of
  premium features. Harder to justify for a single feature bump.

**Recommendation:** Use one-time purchase for individual ceiling removals (group cap,
reroll count). Reserve subscription for a broader premium tier that bundles multiple
enhancements. Never put core 1:1 scheduling behind a paywall.

### Booking referral fees
When Rendezvous deep-links to Resy, OpenTable, Tock, GolfNow, or Fever (all already on
the product roadmap), those platforms have affiliate and partner programs. A completed
booking referral earns a small cut. Fully invisible to the user — they're already clicking
through — and directly aligned with the product experience.

### Concierge / premium suggestions tier
Instead of (or in addition to) rate-limiting plan creation, offer a higher-quality tier:
human-verified reservations, curated experiences (chef's table, private gallery tours,
bespoke itineraries), or a "plan something special" flow with more AI back-and-forth.
Fits the product voice better than a hard usage wall.

### Group planning as a natural paid tier
Group coordination is genuinely harder and more valuable. A "group trip" or "event
planning" mode — with more AI iterations, cost estimate generation, optional booking
support, and quorum logic for larger groups — is a natural premium experience that
doesn't penalize casual 1:1 use.

The free tier caps groups at 15 members. This ceiling is a cost and complexity
decision, not a hard technical limit. Two possible unlock models when the time comes:

- **One-time purchase** (e.g. $0.99–$2.99): "Upgrade to unlimited group size." Low
  friction, no ongoing commitment. Works well for a feature that feels like a ceiling
  removal rather than ongoing value delivery.
- **Subscription** (e.g. $X/month): Better for features that deliver ongoing value —
  concierge tier, higher AI iteration limits, booking support. A subscription for just
  a group size bump is a harder sell.

Recommendation when ready: one-time unlock for the group cap specifically; subscription
for a broader premium tier that bundles multiple enhancements. Do not gate core 1:1
scheduling behind a subscription.

### White-label / API licensing
If the core engine (mutual availability + AI itinerary generation) works well, companies
with similar scheduling needs could pay for it: corporate offsites, dating apps, co-working
spaces, hospitality. This is a later-stage play. The MCP layer already on the roadmap
is a natural interface for this.

### Aggregated, anonymized data / insight products
Venue acceptance vs. decline signals, activity type trends, and neighborhood preference
data — fully aggregated and anonymized — could be valuable to venue discovery platforms
or urban planning tools. Requires explicit user consent and careful privacy design.
Long-term, speculative.

---

## What's explicitly off the table

- Sponsored events or promoted venue placement in suggestions
- Selling or sharing individual user data
- Ads of any kind
