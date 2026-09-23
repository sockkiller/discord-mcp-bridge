// Discord MCP bridge
//
// Exposes a Discord bot as a remote MCP server with three tools:
//   - list_guilds:          which Discord servers the bot is in
//   - list_channels:        text channels in a given server
//   - get_recent_messages:  messages from a channel posted in the last N hours (default 24)
//
// Auth model: this server itself is protected by a shared API key (MCP_API_KEY),
// checked against the Authorization header. The Discord bot token (DISCORD_BOT_TOKEN)
// is only ever used server-side to call Discord's API — it is never sent to Claude.
//
// Required environment variables:
//   DISCORD_BOT_TOKEN  - the bot token from the Discord Developer Portal
//   MCP_API_KEY        - a secret you make up; Claude's custom connector sends it as
//                         "Authorization: Bearer <MCP_API_KEY>" in its request headers
//   PORT               - optional, defaults to 3000 (most hosts set this automatically)

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_KEY = process.env.MCP_API_KEY;
const DISCORD_API = "https://discord.com/api/v10";

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN environment variable.");
  process.exit(1);
}
if (!API_KEY) {
  console.warn("Warning: MCP_API_KEY is not set. This server will accept requests from anyone who has the URL.");
}

async function discordFetch(path, params) {
  const url = new URL(`${DISCORD_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${res.status} ${res.statusText} for ${path}: ${text}`);
  }
  return res.json();
}

function buildServer() {
  const server = new McpServer({ name: "discord-brief", version: "1.0.0" });

  server.registerTool(
    "list_guilds",
    {
      title: "List Discord servers",
      description:
        "List every Discord server (guild) this bot has been invited to, with each server's id and name.",
      inputSchema: {}
    },
    async () => {
      const guilds = await discordFetch("/users/@me/guilds");
      const summary = guilds.map((g) => ({ id: g.id, name: g.name }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.registerTool(
    "list_channels",
    {
      title: "List channels in a server",
      description:
        "List the text channels (and their ids) in a given Discord server. Call list_guilds first to get a guildId.",
      inputSchema: {
        guildId: z.string().describe("The Discord guild (server) id, from list_guilds")
      }
    },
    async ({ guildId }) => {
      const channels = await discordFetch(`/guilds/${guildId}/channels`);
      // type 0 = GUILD_TEXT, type 5 = GUILD_ANNOUNCEMENT
      const textChannels = channels
        .filter((c) => c.type === 0 || c.type === 5)
        .map((c) => ({ id: c.id, name: c.name, type: c.type, parentId: c.parent_id }));
      return { content: [{ type: "text", text: JSON.stringify(textChannels, null, 2) }] };
    }
  );

  server.registerTool(
    "get_recent_messages",
    {
      title: "Get recent messages from a channel",
      description:
        "Fetch messages posted in a Discord text channel within the last N hours (default 24). Returns author, content, timestamp, and any attachment URLs, newest first.",
      inputSchema: {
        channelId: z.string().describe("The Discord channel id, from list_channels"),
        hours: z
          .number()
          .optional()
          .describe("How many hours back to look. Defaults to 24.")
      }
    },
    async ({ channelId, hours }) => {
      const lookbackHours = hours ?? 24;
      const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
      const messages = [];
      let before;

      // Page backwards through history until we cross the cutoff or run out of pages.
      for (let page = 0; page < 10; page++) {
        const batch = await discordFetch(`/channels/${channelId}/messages`, {
          limit: 100,
          before
        });
        if (!batch.length) break;

        let hitCutoff = false;
        for (const m of batch) {
          const ts = new Date(m.timestamp).getTime();
          if (ts < cutoff) {
            hitCutoff = true;
            break;
          }
          messages.push({
            id: m.id,
            author: m.author?.username,
            content: m.content,
            timestamp: m.timestamp,
            attachments: (m.attachments || []).map((a) => a.url)
          });
        }

        before = batch[batch.length - 1].id;
        if (hitCutoff) break;
      }

      return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
    }
  );

  server.registerTool(
    "post_message",
    {
      title: "Post a message to a channel",
      description:
        "Post a message to a Discord text channel as the bot. Long messages are automatically split into multiple posts (Discord's 2000-character limit per message).",
      inputSchema: {
        channelId: z.string().describe("The Discord channel id to post into, from list_channels"),
        content: z.string().describe("The message text to post")
      }
    },
    async ({ channelId, content }) => {
      const MAX = 1900; // leave headroom under Discord's 2000-char hard limit
      const chunks = [];
      let remaining = content;
      while (remaining.length > 0) {
        if (remaining.length <= MAX) {
          chunks.push(remaining);
          break;
        }
        // Prefer to break on the last newline before the limit, so we don't cut mid-sentence.
        let splitAt = remaining.lastIndexOf("\n", MAX);
        if (splitAt <= 0) splitAt = MAX;
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
      }

      const posted = [];
      for (const chunk of chunks) {
        const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${DISCORD_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ content: chunk })
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Discord API ${res.status} ${res.statusText} posting message: ${text}`);
        }
        const data = await res.json();
        posted.push({ id: data.id });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ posted_messages: posted.length, message_ids: posted.map((p) => p.id) }, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("Discord MCP bridge is running.");
});

app.post("/mcp", async (req, res) => {
  if (API_KEY) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${API_KEY}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: String(err?.message || err) });
    }
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Discord MCP bridge listening on port ${port}`);
});
