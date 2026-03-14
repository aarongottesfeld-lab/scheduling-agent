# Rendezvous — scheduling-agent

Full-stack AI scheduling app. React/CRA frontend, Express 5 backend, Supabase + Postgres, Google OAuth, Google Maps, Anthropic Claude.

**Production:** https://rendezvous-gamma.vercel.app
**Supabase:** bgeqxnrwrphbzenfrbdb (us-east-1)
**Vercel project:** prj_ik4LGx6e3UScndzVsIj7ul9BWglr, team: team_CzvVldNaVWk7WAkpXX99eu9K
**GitHub:** aarongottesfeld-lab/scheduling-agent (branch: main)

---

## Reference file map

Load these at the start of any planning or architecture session. Each file's scope is described below so you know which ones are relevant to a given question.

| File | Purpose |
|---|---|
| `ROADMAP.md` | Full feature backlog, prioritization, audit schedule, release gating. Start here for any roadmap or sequencing question. |
| `SPRINT_SPECS.md` | Deep-dive design specs for each feature sprint — prompt engineering, venue quality, live events, activity venues, group scheduling, location/travel mode, timezone, cultural moment scheduling. Reference when implementing a specific feature. |
| `BETA_TESTING.md` | Beta plan, tester management process, feedback form links, bug bash format, PostHog analysis approach. |
| `GROUP_MODE_SCHEMA.md` | Full proposed DB schema for group mode — tables, RLS, triggers, indexes, design decisions. Reference when touching group mode DB. |
| `CLAUDE_CODE_PROMPTS.md` | Saved Claude Code prompts ready to execute for upcoming roadmap items. Each prompt is self-contained with parity instructions. |
| `MONETIZATION.md` | Pricing model thinking. Intentionally separate from the build — reference only when upkeep costs make revenue a real consideration. |
| `competitive/MOAT.md` | Competitive positioning and long-term moat thinking. Intentionally separate from the build. |
| `competitive/` | Folder for all competitive and positioning docs. Currently contains MOAT.md. |
| `audit-2026-03-12.md` | Audit 2 results — security/privacy/DR findings, severity ratings, and resolution status. |
| `STATUS.md` | Session-by-session dev notes and completed work log. Updated at the end of every significant session alongside a Google Calendar save state. ROADMAP.md takes precedence if the two conflict. |

---

## Key identifiers (for new sessions)

```
Project root:   ~/Documents/scheduling-agent
Production:     https://rendezvous-gamma.vercel.app
Supabase:       bgeqxnrwrphbzenfrbdb (us-east-1)
Vercel project: prj_ik4LGx6e3UScndzVsIj7ul9BWglr
Vercel team:    team_CzvVldNaVWk7WAkpXX99eu9K
GitHub:         aarongottesfeld-lab/scheduling-agent (main)
```

## Dev test users (Supabase — use dev switcher at localhost:3001/dev/users)

| Username | UUID | Location | Vibe |
|---|---|---|---|
| jamiec | 11111111-1111-1111-1111-111111111111 | Upper West Side | Sports, golf, rooftop bars |
| mrivera | 22222222-2222-2222-2222-222222222222 | Brooklyn Heights | Broadway, jazz, fine dining, vegetarian |
| tkim | 33333333-3333-3333-3333-333333333333 | Midtown East | Tennis, golf, concerts |
| alexp | 44444444-4444-4444-4444-444444444444 | Astoria | Mets, escape rooms, gluten-free |

Aaron's Supabase UUID: `b522125b-2698-4c74-bc24-a441754f1a12`

## AI model config
- Dev (localhost): `claude-haiku-4-5-20251001`
- Prod (Vercel): `claude-sonnet-4-5-20250929`

## Save state system
Project state is saved using two parallel mechanisms that should stay in sync:
1. **Google Calendar** — all-day event titled `Rendezvous Save State — [description]`. Contains git SHA, completed work, and what's next. Used as mobile fallback when STATUS.md can't be updated directly.
2. **STATUS.md** — append an entry with the same info at the end of each session.

At the start of each session, check GCal for save states newer than the last STATUS.md entry and backfill before proceeding. If the two are out of sync, GCal is the fallback source of truth.
