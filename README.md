# Discord MCP Bridge

A tiny server that exposes a Discord bot as a remote MCP server Claude can connect to
as a custom connector. It gives Claude three tools:

- `list_guilds` — which Discord servers the bot is in
- `list_channels` — text channels in a given server
- `get_recent_messages` — messages from a channel in the last N hours (default 24)

## Deploy on Render (recommended, free tier works)

1. Push this folder to a new GitHub repo (create a repo on github.com, then use
   "Add file > Upload files" in the browser to drag these files in — no git
   command line needed).
2. Go to https://render.com, sign in, click **New > Web Service**, and connect
   the GitHub repo you just created.
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Under **Environment**, add these environment variables:
   - `DISCORD_BOT_TOKEN` — your bot's token from the Discord Developer Portal
   - `MCP_API_KEY` — make up a long random secret string (this protects your
     server from strangers; you'll paste the same value into Claude's connector
     setup as a request header)
5. Click **Create Web Service**. Render will build and deploy it, then give you
   a public URL like `https://discord-mcp-bridge.onrender.com`.
6. Your MCP server URL to give Claude is that URL plus `/mcp`, e.g.
   `https://discord-mcp-bridge.onrender.com/mcp`.

## Connecting it to Claude

In Claude's custom connector setup:

- **Remote MCP server URL:** `https://<your-render-url>/mcp`
- **Authentication:** choose "No sign-in" (this server uses a header-based API
  key, not OAuth)
- **Request headers:** add `Authorization: Bearer <your MCP_API_KEY value>`

## Notes

- The Discord bot token never leaves this server — it's only used server-side
  to call Discord's API. Claude only ever sees your `MCP_API_KEY`.
- The bot must already be a member of the server(s) you want it to read, and
  the Discord Developer Portal's "Message Content Intent" must be enabled for
  it to see message text via the API.
- Render's free tier spins down after inactivity and takes ~30-60 seconds to
  wake back up on the next request — fine for an overnight/scheduled brief,
  might feel slow if you query it manually right after it's been idle.
