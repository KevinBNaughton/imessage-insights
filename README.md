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

## API

All `/v1` routes need `Authorization: Bearer $INSIGHTS_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check, no auth |
| GET | `/v1/triage?lookbackDays=14&includeHidden=false` | `needsReply`, `waitingOnThem`, `unknownSender`, each longest-waiting first, with the last few messages for context |
| GET | `/v1/chats/:chatGuid/messages?limit=50` | Conversation, oldest first |
| GET | `/v1/search?q=dinner&lookbackDays=30&chatGuid=` | Text search across messages |
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
