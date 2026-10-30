# AGENTS.md

Read-only iMessage triage service on top of a local BlueBubbles server. Exposes a REST API, a CLI and
an MCP server. See README.md for setup and usage.

## Hard rules

- **Never add anything that sends, edits, unsends or deletes messages.** `src/bluebubbles.ts` wraps only
  GET endpoints and POST `*/query` endpoints on purpose. "Done/snooze/mute" only touch the local SQLite
  state in `src/store.ts`, never Messages.
- **Never log or return the BlueBubbles password.** It travels as a `?password=` query param, so error
  messages must not include request URLs.
- **Don't start mock or duplicate servers** next to the real BlueBubbles; the host Mac is short on RAM.
  Test against the real server, and point `DB_PATH` at a scratch file when testing done/mute/snooze so the
  user's real state isn't touched.

## Commands

```sh
npm test          # node:test, runs TypeScript directly
npm run typecheck # tsc --noEmit
npm run triage    # live report against the real BlueBubbles (needs .env)
npm start         # REST API + POST /mcp on 127.0.0.1:8787
```

Node 23.6+ runs the `.ts` files directly via type stripping, so only erasable TypeScript is allowed: no
`enum`, `namespace`, or constructor parameter properties (`tsconfig` enforces `erasableSyntaxOnly`).
Imports use explicit `.ts` extensions. SQLite comes from built-in `node:sqlite`.

## Layout

- `src/bluebubbles.ts`: read-only BlueBubbles client, plus `buildTextSearchWhere` (see below)
- `src/triage.ts`: pure triage rules (buckets, priority, automated/ack/OTP detection); unit-tested
- `src/service.ts`: fetches chats/messages, merges a person's SMS + iMessage threads, applies state
- `src/store.ts`: local done/snooze/mute state
- `src/mcp.ts`: MCP tools; `src/mcp-stdio.ts` (local stdio), `/mcp` in `src/server.ts` (HTTP)
- `src/cli.ts`: numbered terminal report and done/mute/snooze/undo commands
- `scripts/launch-agent.sh`: LaunchAgent that keeps `npm start` running for the Cloudflare-tunneled connector

## BlueBubbles quirks (learned from real data)

- Message `text` is already extracted from `attributedBody` by the server; no extra parsing needed.
- Text search: a `where` statement containing the literal `message.text` gets rerouted to the Private API's
  Spotlight search, which hangs on this Mac. Write `message."text"`. Many messages (most sent ones) have
  NULL `text`, so also byte-search `attributedBody` with `instr()`. `CAST(blob AS TEXT)` stops at the
  first NUL byte and silently matches nothing.
- iPhone text uses curly apostrophes (’). Normalize before pattern matching.
- Tapbacks have a non-zero `associatedMessageType` (number or string like `"love"`); ignore them when
  deciding who spoke last.
- Chat `style` 43 = group, 45 = 1:1.
- `after`/`before` on BlueBubbles message endpoints are inclusive (`>=`/`<=`). The service nudges them by
  1ms and returns millisecond timestamps so paging cursors don't repeat the boundary message.

## Using the MCP tools (for an assistant)

Tools: `get_inbox`, `find_conversations`, `read_conversation`, `search_messages`, `mark_done`,
`snooze_conversation`, `mute_conversation`, `unhide_conversation`.

Typical flow: `get_inbox` → `find_conversations` (name → `chat_id`) → `read_conversation` for context.
To zoom into a moment: `search_messages` → `read_conversation` with `around` = the hit's `at`, or use
`after`/`before` for a known stretch, paging with `nextAfter`/`nextBefore`.
When the user wants to reply, draft the text for them to send; there is no send tool.

Example requests: "Who am I behind on texting?", "What did Subin and I last talk about?",
"Search my texts for the Tahoe trip plans", "What did Katherine and I talk about the night of Oct 9?",
"Mute the SkyMiles chat".
