# Rendezvous

**AI-powered scheduling that finds when you're free and plans what to do.**

[Try it live](https://rendezvous-gamma.vercel.app/)

Rendezvous connects to your Google Calendar, finds mutual availability between you and your friends, and generates personalized itinerary suggestions using Claude. It handles everything from a casual dinner for two to a group outing with quorum-based voting.

---

## What it does

- **Calendar sync** — connects to Google Calendar (with support for multiple accounts) and Apple Calendar (via CalDAV) to read busy/free times, then writes confirmed events back
- **AI itinerary generation** — Claude generates venue-specific suggestions tailored to each person's preferences, dietary restrictions, mobility needs, location, and activity interests
- **Venue enrichment** — Google Maps integration validates and enriches venue suggestions with real addresses, ratings, and hours
- **Group scheduling** — groups with invite flows, quorum-based voting on suggestions, and conflict detection across all members' calendars
- **Smart rerolls** — when a suggestion doesn't land, the reroll system classifies intent (different vibe, different area, different time, etc.) and regenerates accordingly
- **Push notifications** — Firebase Cloud Messaging for itinerary updates, friend requests, group invites, and nudges
- **MCP server** — a standalone Model Context Protocol server exposing scheduling tools for use in Claude Desktop and other MCP clients

## Architecture

```
client/          React 19 SPA (Create React App)
server/          Express 5 API (Node.js, CommonJS)
mcp/             MCP server (OAuth 2.1, standalone deployment)
supabase/        Postgres migrations and RLS policies
```

The app deploys as a single Vercel project. The React frontend and Express backend share a domain — `vercel.json` routes `/api/*` to the serverless function and everything else to the SPA. The server runs identically in local dev (`node server/index.js`) and in Vercel's serverless runtime.

### Key technical decisions

- **HTTP-only cookie sessions** backed by a Supabase `sessions` table (no JWTs, no in-memory state, serverless-safe)
- **Row-level security** on all Supabase tables — the server uses a service role key, but every table has RLS policies so even direct DB access is scoped to the authenticated user
- **Claude prompt engineering** for itinerary generation — structured system prompts with user context injection, venue validation rules, and cultural moment awareness
- **Rate limiting** with per-user daily caps on AI generation endpoints
- **Atomic database operations** via Postgres RPCs for race-prone flows (voting, calendar connection switching)

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, React Router 7, Axios, PostHog, Firebase |
| Backend | Express 5, Node.js |
| AI | Anthropic Claude (Haiku for dev, Sonnet for prod) |
| Database | Supabase (Postgres), with RLS and stored procedures |
| Auth | Google OAuth 2.0 (Calendar + profile scopes) |
| Maps | Google Maps Platform (Places, Geocoding) |
| Notifications | Firebase Cloud Messaging |
| MCP | Custom OAuth 2.1 server with tool endpoints |
| Deployment | Vercel (serverless) |
| Analytics | PostHog |

## MCP server

The `mcp/` directory contains a standalone MCP server that exposes Rendezvous functionality as tools for AI assistants. It supports:

- Checking availability and finding free times
- Generating and managing itineraries
- Friend and group management
- Full OAuth 2.1 flow for third-party MCP clients

See [`mcp/README.md`](mcp/README.md) for setup and usage.

## Local development

```bash
# Clone and install
git clone https://github.com/aarongottesfeld-lab/scheduling-agent.git
cd scheduling-agent
cd server && npm install && cd ../client && npm install

# Configure environment
cp server/.env.example server/.env   # fill in your keys
cp client/.env.example client/.env   # optional

# Run (two terminals)
cd server && npm run dev             # Express on :3001
cd client && npm start               # React on :3000
```

Required environment variables for the server:
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `ANTHROPIC_API_KEY`
- `GOOGLE_MAPS_API_KEY`

## License

This project is source-available for portfolio and reference purposes. Not licensed for commercial use or redistribution.
