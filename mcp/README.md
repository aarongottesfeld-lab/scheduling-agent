# Rendezvous MCP Server

Exposes Rendezvous scheduling tools to AI clients (Claude Desktop, ChatGPT, etc.) via the [Model Context Protocol](https://modelcontextprotocol.io/).

## Tools (15)

| Tool | Description |
|------|-------------|
| `get_friends` | List accepted friends with optional search |
| `get_availability` | Find free time windows between user and a friend |
| `get_itineraries` | List 1-on-1 itineraries (pending/locked/all) |
| `get_itinerary` | Get full itinerary details with suggestions |
| `create_itinerary_request` | Create a new 1-on-1 plan (async generation) |
| `get_itinerary_job` | Poll generation status |
| `reroll_itinerary` | Regenerate suggestions with feedback |
| `respond_to_itinerary` | Accept or decline an itinerary |
| `lock_itinerary` | Lock an itinerary and create calendar events |
| `get_groups` | List user's groups |
| `get_group_itineraries` | List itineraries for a group |
| `get_group_itinerary` | Get full group itinerary with vote status |
| `create_group_itinerary_request` | Create a group plan (async generation) |
| `vote_on_group_itinerary` | Vote accept/decline/abstain on a group plan |
| `counter_propose_group_itinerary` | Request a reroll with feedback |

## Local Development

```bash
cd mcp
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MCP_API_KEY, MCP_OWNER_USER_ID
npm install
npm run dev
```

The server starts on `http://localhost:3002`.

## Authentication

### Dev shortcut (MCP_API_KEY)

Set `MCP_API_KEY` and `MCP_OWNER_USER_ID` in `.env`. All requests with `Authorization: Bearer <MCP_API_KEY>` are treated as the owner user. A warning is logged on every use.

### OAuth (production)

1. AI client redirects user to `GET /oauth/authorize?client_id=...&redirect_uri=...&response_type=code&state=...`
2. User approves on the Rendezvous consent screen
3. AI client exchanges the code at `POST /oauth/token` for a Bearer access token (24h expiry)

## Connecting to Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rendezvous": {
      "url": "http://localhost:3002/sse",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_API_KEY"
      }
    }
  }
}
```

## Connecting via SSE URL (Claude.ai)

Use the SSE endpoint URL: `http://localhost:3002/sse` (or your production URL).

## Async Generation

Itinerary generation (`create_itinerary_request`, `reroll_itinerary`, `create_group_itinerary_request`) is async. After calling these tools, poll `get_itinerary_job` every 3-5 seconds until status is `ready` or `failed`.

## Deployment

This server requires a persistent process for SSE connections. Deploy to:

- **Railway** (recommended)
- **Render**
- **Any VPS** (Docker, EC2, etc.)

Vercel serverless will NOT work — SSE requires long-lived connections.

Set all environment variables from `.env.example` in your deployment platform.
