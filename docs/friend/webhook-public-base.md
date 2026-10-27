# Public webhook URLs without T3 Connect

Webhook tasks (`schedule_task` with `schedule: { type: "webhook" }`) need a URL that services outside
the tailnet can call, such as the WhatsApp MCP on Railway posting to its `callback_url`. T3 Connect
gives one through its relay. Without Connect, set `T3CODE_WEBHOOK_PUBLIC_BASE_URL` on the server and
expose only the hook route publicly.

## Setup

1. Publish only `/api/hooks/` of the server on an https origin, keeping the path. With Tailscale
   Funnel, mount `/api/hooks` on its own https port so the rest of the API stays tailnet-only.
2. Set the env on the server, with no trailing slash:

   ```ini
   Environment=T3CODE_WEBHOOK_PUBLIC_BASE_URL=https://omarchy.taild92f5b.ts.net:8443
   ```

3. Restart the server. New and listed webhook tasks return
   `webhookUrl = <base>/api/hooks/<task id>/<token>`. The value is read when the server starts.

If the relay of T3 Connect is configured, its URL keeps priority. An `http://` base, a trailing slash,
a query, a hash or credentials make the server ignore the env and log a warning.

## What the URL exposes

The token in the URL is the credential: anyone holding the URL can start the task. Keep it out of
logs and chats, set a signing secret on the task when the sender supports one, and rotate the task's
webhook token if it leaks. Each task keeps its own rate limit. A wrong token answers 404 and records
nothing.
