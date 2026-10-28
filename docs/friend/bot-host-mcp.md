# Host MCP servers for a guest's bot

A guest's bot runs Claude Code in a sandbox with no route to the host and no secrets. To give one bot
the tools of an MCP server that runs on the host (say a read-only bank data server), list the server
for that bot in a JSON file on the host. T3 connects to the server, sends its token, and offers its
tools to the bot the same way it offers the guest tools (`mcp__t3-guest__*`): as an in-process MCP
server over the CLI's stdin/stdout. The tools show up as `mcp__<name>__<tool>`, pre-approved.

## Setup

1. Put the server's token in a file only the T3 user can read, one line, for example
   `~/.config/t3-bia/pluggy-mcp.token` with mode `600`.
2. Write the config, by default `~/.t3-friend/bot-host-mcp.json` (set
   `T3CODE_BOT_HOST_MCP_FILE` to use another path):

   ```json
   {
     "b_ef77ffdd036846deb904d119e3e5e53a": [
       {
         "name": "pluggy",
         "url": "http://127.0.0.1:3796/mcp",
         "tokenFile": "~/.config/t3-bia/pluggy-mcp.token"
       }
     ]
   }
   ```

3. Start a new turn of the bot. The file is read at every turn of a guest's bot, so no restart is
   needed. A tool list is fixed when the bot's Claude session opens; a server added or recovered
   later shows up when the session is replaced (a changed server list does that by itself).

The server must speak MCP Streamable HTTP (`POST <url>`, stateless is fine) and accept
`Authorization: Bearer <token>`.

## Rules

- Only the bots listed get the servers, and only when they belong to a guest (other bots run
  Claude Code on the host and do not need this). Another bot of the same guest gets nothing.
- `name` matches `[a-z0-9_-]+`, is unique per bot, and is neither `t3-guest` nor `t3-code`.
- `url` is `http` or `https` on `127.0.0.1`, `localhost` or `[::1]`, without credentials.
- `tokenFile` may start with `~/`. The token is read for each request, so rotating it needs no
  restart. It is sent only as the Bearer header; it is redacted from logged errors and never reaches
  the sandbox.
- A missing file forwards nothing. An invalid file forwards nothing for any bot and logs
  `Bot host MCP config is unusable` with the reason.
- A server that is down, rejects the token, or does not list its tools within 5 seconds gives the
  bot no tools from it for that turn. A missing or empty token file does the same, without calling
  the server. A call that fails or takes more than 30 seconds returns an error result to the bot.
  The turn and the `t3-guest` tools are never affected.

See [`apps/server/src/bots/guest/HostMcpForward.ts`](../../apps/server/src/bots/guest/HostMcpForward.ts).
