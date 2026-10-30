# imessage-insights

A small, read-only API on top of a [BlueBubbles](https://bluebubbles.app) server that answers:

- **Who's waiting on me?** DMs where they sent the last message, plus group chats where you were mentioned or asked something.
- **Who owes me a reply?** DMs where you asked a question and haven't heard back.
- **Who's new?** First-contact messages from people not in your contacts.

It's built for AI assistants: give the assistant this service's token, never the BlueBubbles password.
This service can't send, edit or delete messages.

## Setup

Requires Node 23.6+ (runs TypeScript directly, uses built-in `node:sqlite`) and a running BlueBubbles server.

```sh
npm install
cp .env.example .env   # fill in BLUEBUBBLES_PASSWORD and INSIGHTS_TOKEN (openssl rand -hex 32)
npm run triage         # print the current report in the terminal
npm start              # start the API on 127.0.0.1:8787
```

### Clearing items from the terminal

`npm run triage` numbers every item. Then:

```sh
npm run triage -- done 3 5      # handled; comes back only if they message again
npm run triage -- mute 4        # never show this chat again (businesses, noisy groups)
npm run triage -- snooze 6 48   # hide for 48 hours (default 24)
npm run triage -- --include-hidden   # list hidden chats too, tagged [done]/[muted]/[snoozed]
npm run triage -- undo 4        # restore (number from an --include-hidden listing)
```

## MCP (use it from Claude)

Tools: `get_inbox`, `find_conversations`, `read_conversation`, `search_messages`, plus `mark_done`,
`snooze_conversation`, `mute_conversation`, `unhide_conversation` (these only change this service's list).

`read_conversation` and `search_messages` take `after`/`before` (ISO 8601; bare dates and offset-less
times are local), and `read_conversation` also takes `around` to show context on both sides of a moment,
such as a search hit. Timestamps come back in local time. Tapbacks are hidden unless `include_reactions`
is set; page with the returned `nextAfter`/`nextBefore`.

BlueBubbles must be running; otherwise the tools return an error instead of results.

### Claude Code

The stdio server reads `.env` from the repo, so it needs no env vars. Register it once for all projects:

```sh
claude mcp add imessage --scope user -- "$(node -p process.execPath)" "$PWD/src/mcp-stdio.ts"
claude mcp get imessage     # should show "✔ Connected"
```

Use the real `node` binary (`node -p process.execPath`), not a version-manager shim such as an
fnm/nvm path that changes per shell.

MCP servers load only when a session starts, so after adding it:

1. `/exit` the current session
2. restart with `claude --continue` (same conversation) or `claude` (fresh)
3. run `/mcp` and check that `imessage` is listed with 8 tools

Then just ask:

- "Who am I behind on texting?"
- "What did Subin and I last talk about?"
- "Search my texts for the Tahoe trip plans"
- "What did Katherine and I talk about the night of Oct 9?"
- "Find where I said 'figure out later' and show me what led up to it"
- "Mute the SkyMiles chat"

Claude Code asks permission the first time each tool runs. Choose "don't ask again", or add
`mcp__imessage` to `permissions.allow` in your settings to skip the prompts.

To remove it: `claude mcp remove imessage -s user`

### Claude Desktop

Claude Desktop must run on the same Mac as BlueBubbles and this repo, since it launches the stdio server
locally. For another machine or your phone, see [Over HTTP](#over-http).

1. Install Claude Desktop and open it once, so it creates `~/Library/Application Support/Claude/`.
2. Get the absolute paths to fill in. Desktop doesn't load your shell setup, so use the real `node`
   binary, not a version-manager shim:

   ```sh
   node -p process.execPath   # node path
   echo "$PWD/src/mcp-stdio.ts"  # server path, run from the repo root
   ```

3. Add the server to `~/Library/Application Support/Claude/claude_desktop_config.json` (create it if
   missing; if it already has `mcpServers`, add `imessage` alongside the others):

   ```json
   {
     "mcpServers": {
       "imessage": {
         "command": "/absolute/path/to/node",
         "args": ["/absolute/path/to/imessage-insights/src/mcp-stdio.ts"]
       }
     }
   }
   ```

   No env vars are needed; the server reads `.env` from the repo.
4. Quit Claude Desktop fully (Cmd+Q) and reopen it. The `imessage` tools should appear in the
   tools/connectors menu.

If you later remove that Node version (e.g. `fnm uninstall`), update `command` with the new
`node -p process.execPath`.

### Over HTTP

`npm start` also serves Streamable HTTP MCP at `POST /mcp`, behind the same bearer token.
This is what a remote Claude custom connector (phone) will point at once it's tunneled.

## API

All `/v1` routes need `Authorization: Bearer $INSIGHTS_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check, no auth |
| GET | `/v1/triage?lookbackDays=14&includeHidden=false` | `needsReply`, `waitingOnThem`, `unknownSender`, each longest-waiting first, with the last few messages for context |
| GET | `/v1/chats/:chatGuid/messages?limit=50&after=&before=&around=&includeReactions=` | Conversation, oldest first, optionally a time window |
| GET | `/v1/search?q=dinner&after=&before=&lookbackDays=30&chatGuid=` | Text search across messages |
| POST | `/v1/chats/:chatGuid/done` | Hide until a new message arrives in the chat |
| POST | `/v1/chats/:chatGuid/snooze` `{"hours": 24}` or `{"until": "2026-10-20T09:00:00Z"}` | Hide until then |
| POST | `/v1/chats/:chatGuid/mute` | Always hide |
| DELETE | `/v1/chats/:chatGuid/state` | Undo done/snooze/mute |

Chat GUIDs contain `;` and `+`, so URL-encode them (`encodeURIComponent`).
Done/snooze/mute only affect this service's reports; nothing changes in Messages.

## Triage rules

- Tapbacks, reactions, group events and empty rows are ignored when deciding who spoke last.
- Short-code senders and one-time-code texts are never flagged.
- `needsReply` waits `NEEDS_REPLY_MIN_AGE_HOURS` (default 1) before flagging; `waitingOnThem` waits `WAITING_MIN_AGE_HOURS` (default 48).
- Group chats are flagged only on a question or a mention of a name in `MY_NAMES`.

## Remote access

Keep `HOST=127.0.0.1` and expose **only this port** through a tunnel (e.g. Cloudflare Tunnel + Access).
Don't expose the BlueBubbles port publicly: its single password allows sending and deleting messages.

## Roadmap

- [ ] LLM pass (Claude API) over flagged threads: commitments ("I'll send it Friday"), one-line summaries, suggested actions
- [ ] MCP server exposing the same tools
- [ ] BlueBubbles webhook receiver for incremental updates instead of a full scan per request
- [ ] Daily digest
