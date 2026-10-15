# Apple Data MCP

MCP server that exposes personal Apple data - Notes, Calendar, Reminders, iMessage, Mail, Contacts, and Obsidian - to AI agents. Part of the Railway hub + Mac tunnel pattern: a cloud MCP endpoint that proxies securely to a daemon running on your own machine.

Nothing leaves your device except what you ask for. The cloud component holds no data - it is a stateless proxy that forwards MCP requests over an authenticated WebSocket tunnel to the local daemon.

## Architecture

```
AI client (cloud)
  | HTTPS POST/DELETE /mcp (Bearer auth via APPLE_DATA_MCP_KEY)
Railway Hub (railway-hub.js)
  | WebSocket /tunnel (auth via TUNNEL_TOKEN)
Tunnel Client (tunnel-client.js, launchd on Mac)
  | HTTP localhost
Local Daemon (src/daemon.js)
  | native APIs / AppleScript
Apple data + Obsidian vault
```

- Single-tenant: one Mac, one tunnel connection. A new tunnel connection replaces a stale one.
- When the Mac is offline, `/mcp` returns `503` with a clear error instead of hanging.
- SSE notifications are intentionally unsupported through the proxy (Railway buffers SSE); all tools are synchronous request/response.

## Files

| File | Purpose |
|------|---------|
| `railway-hub.js` | Railway WebSocket hub - HTTP `/mcp` + WS `/tunnel` + `/health` |
| `tunnel-client.js` | Mac daemon - zero-dep, native WebSocket, heartbeat + auto-reconnect |
| `src/daemon.js` | Local MCP daemon implementing the Apple data tools |
| `Dockerfile.railway` | Railway container build |
| `railway.json` | Railway service config |

## Env Vars

### Railway Hub

| Variable | Purpose |
|----------|---------|
| `PORT` | Set automatically by Railway |
| `APPLE_DATA_MCP_KEY` | Bearer token for the `/mcp` endpoint (client-facing) |
| `TUNNEL_TOKEN` | Bearer token for the `/tunnel` WebSocket (Mac-facing) |

If either token is unset the hub starts but warns loudly - both auth layers are optional only for local testing.

### Mac Tunnel Client

Set the hub URL and a matching `TUNNEL_TOKEN`, then keep it running under launchd.

## Setup

1. Create a Railway service from this repo and set `APPLE_DATA_MCP_KEY` + `TUNNEL_TOKEN` (e.g. `openssl rand -hex 32`)
2. On the Mac: `npm install`, point the tunnel client at `wss://<your-app>.up.railway.app/tunnel`, install via launchd for auto-start
3. Point your AI client at `https://<your-app>.up.railway.app/mcp` with `Authorization: Bearer <APPLE_DATA_MCP_KEY>`
4. Verify: `GET /health` returns `{"status":"ok","tunnelConnected":true}`

## Related

Same pattern as [apple-health-mcp-tunnel](https://github.com/dbalchunas2-pixel/apple-health-mcp-tunnel) and [pearson-mcp-railway](https://github.com/dbalchunas2-pixel/pearson-mcp-railway) - a family of tunnel MCP servers that keep private data local while making it available to cloud AI agents.
