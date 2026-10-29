# Host MCP servers for a bot

To give one bot the tools of an MCP server that runs on the host (say a read-only bank data server)
without handing the bot its token, list the server for that bot in a JSON file on the host. T3
connects to the server, sends its token, and offers its tools to the bot as an in-process MCP server
over the Claude CLI's stdin/stdout. A guest's bot gets them beside its guest tools
(`mcp__t3-guest__*`) without its sandbox gaining a route to the host. The tools show up as
`mcp__<name>__<tool>`, pre-approved.

## Setup

1. Put the server's token in a file only the T3 user can read, one line, for example
   `~/.config/t3-bia/pluggy-mcp.token` with mode `600`.
2. Write the config, by default `~/.t3-friend/bot-host-mcp.json` (set
   `T3CODE_BOT_HOST_MCP_FILE` to another absolute path to move it):

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

3. Start a new turn of the bot. The file is read at every turn of a bot, so no restart is
   needed. When a server's address, token file or tool list changes, or a server appears or drops
   out, the bot's next turn opens a new Claude session with the new tools.

The server must speak MCP Streamable HTTP (`POST <url>`, stateless is fine) and accept
`Authorization: Bearer <token>`.

## Rules

- Only the bots listed get the servers; another bot, of the same guest or not, gets nothing. Only
  Claude instances take them: a bot on Codex or another provider gets no forwarded tools.
- `name` matches `[a-z0-9_-]+`, is unique per bot, and is neither `t3-guest` nor `t3-code`.
- `url` is `http` or `https` on the literal address `127.0.0.1` or `[::1]`, without credentials.
  `localhost` is refused, since it resolves through DNS. Redirects are never followed.
- `tokenFile` is an absolute path or starts with `~/`. It and the config must be regular files, not
  symlinks; the token file holds at most 4 KiB, the config 64 KiB. The token is read for each
  request, so rotating it needs no restart. It goes only into the Bearer header and is replaced by
  `[redacted]` in everything the server sends back to the bot (tool descriptions, schemas, results,
  errors) and in logged errors. A tool whose name contains the token is dropped.
- A missing config forwards nothing. An invalid or unreadable one forwards nothing for any bot and
  logs `Bot host MCP config is unusable` with the reason.
- A server may answer with at most 4 MiB per response, 128 tools and 64 content blocks per result.
  Past that, the bot gets no tools from it for the turn, or an error result for the call.
- A server that is down, rejects the token, or does not list its tools within 5 seconds (token read
  included) gives the bot no tools from it for that turn. A missing, empty or refused token file does
  the same, without calling the server. A call that fails or takes more than 30 seconds returns an error result to the bot.
  The turn and a guest bot's `t3-guest` tools are never affected.

See [`apps/server/src/bots/guest/HostMcpForward.ts`](../../apps/server/src/bots/guest/HostMcpForward.ts).
