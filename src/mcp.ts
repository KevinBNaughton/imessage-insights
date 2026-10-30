import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InsightsService } from "./service.ts";
import type { StateStore } from "./store.ts";
import { parseWhen } from "./time.ts";
import type { ChatTriage } from "./triage.ts";

// MCP tools over the triage service. Read tools never change anything; the done/snooze/mute
// tools only change this service's own list, never Messages itself.

const READ = { readOnlyHint: true, openWorldHint: false } as const;

const WHEN =
    "ISO 8601 date or time. A bare date (2026-10-09) is local midnight at the start of that day; times without an " +
    "offset are local (e.g. 2026-10-09T20:30).";
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function json(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function compact(t: ChatTriage) {
    return {
        chat_id: t.chatGuid,
        title: t.title,
        priority: t.priority,
        reason: t.reason,
        is_group: t.isGroup,
        hours_since_last_message: t.hoursSinceLastMessage,
        unanswered_count: t.unansweredCount,
        recent_messages: t.recent.map(m => `[${m.at}] ${m.from}: ${m.text}`)
    };
}

export function createMcpServer(service: InsightsService, store: StateStore): McpServer {
    const server = new McpServer(
        { name: "imessage-insights", version: "0.1.0" },
        {
            instructions:
                "Read-only access to the user's iMessages and SMS via their Mac. Start with get_inbox to see who is waiting on " +
                "a reply. Use find_conversations to turn a person's name into a chat_id, then read_conversation for context. " +
                "These tools cannot send messages; when the user wants to reply, draft the text for them to send themselves."
        }
    );

    server.registerTool(
        "get_inbox",
        {
            title: "Get message inbox triage",
            description:
                "Lists conversations that need attention: needs_reply (they sent the last message; questions and mentions marked " +
                "high priority, 'thanks'/'lol' endings marked low), waiting_on_them (the user asked a question with no answer), " +
                "and unknown_senders. Automated/business texts and chats the user marked done, muted or snoozed are left out.",
            inputSchema: {
                lookback_days: z.number().int().min(1).max(90).optional().describe("How far back to look. Default 14."),
                include_automated: z.boolean().optional().describe("Also list automated/business texts. Default false.")
            },
            annotations: READ
        },
        async ({ lookback_days, include_automated }) => {
            const report = await service.triage({ lookbackDays: lookback_days });
            return json({
                generated_at: report.generatedAt,
                needs_reply: report.needsReply.map(compact),
                waiting_on_them: report.waitingOnThem.map(compact),
                unknown_senders: report.unknownSender.map(compact),
                automated: include_automated ? report.automated.map(compact) : { count: report.automated.length },
                hidden_by_user: report.hiddenCount
            });
        }
    );

    server.registerTool(
        "find_conversations",
        {
            title: "Find conversations by name",
            description: "Finds chats by contact name, group name, phone number or email. Returns chat_ids, most recent first.",
            inputSchema: {
                name: z.string().min(1).describe("Part of a name, group title, phone number or email"),
                limit: z.number().int().min(1).max(50).optional()
            },
            annotations: READ
        },
        async ({ name, limit }) => json(await service.findChats(name, limit))
    );

    server.registerTool(
        "read_conversation",
        {
            title: "Read a conversation",
            description:
                "Returns messages in a chat, oldest first, with local timestamps. With no time options, returns the latest " +
                "messages. Use `after`/`before` to read a specific stretch, or `around` to see context on both sides of a " +
                "moment (e.g. a search_messages hit's `at`). Tapbacks/reactions are hidden unless include_reactions is true. " +
                "If `truncated` is true there is more: page forward with `after` = `nextAfter`, or backward with " +
                "`before` = `nextBefore`.",
            inputSchema: {
                chat_id: z.string().describe("chat_id from get_inbox, find_conversations or search_messages"),
                limit: z.number().int().min(1).max(200).optional().describe("Max messages. Default 40."),
                after: z.string().optional().describe(WHEN + " Only `after`: reads forward from this point."),
                before: z.string().optional().describe(WHEN + " Returns the latest messages before this point."),
                around: z.string().optional().describe(WHEN + " Returns ~limit/2 messages on each side. Ignores after/before."),
                include_reactions: z.boolean().optional().describe("Include tapbacks and system events. Default false.")
            },
            annotations: READ
        },
        async ({ chat_id, limit, after, before, around, include_reactions }) =>
            json(
                await service.conversation(chat_id, {
                    limit: limit ?? 40,
                    includeReactions: include_reactions,
                    after: after ? parseWhen(after) : undefined,
                    before: before ? parseWhen(before) : undefined,
                    around: around ? parseWhen(around) : undefined
                })
            )
    );

    server.registerTool(
        "search_messages",
        {
            title: "Search messages",
            description:
                "Searches message text across all chats (or one chat), newest first. Matches substrings, not meaning. " +
                "To see a hit in context, call read_conversation with its chatGuid and `around` = its `at`.",
            inputSchema: {
                query: z.string().min(2),
                chat_id: z.string().optional(),
                after: z.string().optional().describe(WHEN),
                before: z.string().optional().describe(WHEN),
                lookback_days: z.number().int().min(1).max(3650).optional().describe("Shortcut for `after`; ignored if `after` is set."),
                limit: z.number().int().min(1).max(100).optional().describe("Default 25.")
            },
            annotations: READ
        },
        async ({ query, chat_id, after, before, lookback_days, limit }) =>
            json(
                await service.search(query, {
                    chatGuid: chat_id,
                    after: after ? parseWhen(after) : undefined,
                    before: before ? parseWhen(before) : undefined,
                    lookbackDays: lookback_days,
                    limit: limit ?? 25
                })
            )
    );

    server.registerTool(
        "mark_done",
        {
            title: "Mark conversation handled",
            description: "Hides a chat from get_inbox until a new message arrives in it. Does not change anything in Messages.",
            inputSchema: { chat_id: z.string() },
            annotations: LOCAL_WRITE
        },
        async ({ chat_id }) => {
            const lastMessageGuid = await service.latestMessageGuid(chat_id);
            store.set({ chatGuid: chat_id, status: "done", lastMessageGuid, snoozeUntil: null });
            return json({ ok: true, chat_id, status: "done" });
        }
    );

    server.registerTool(
        "snooze_conversation",
        {
            title: "Snooze conversation",
            description: "Hides a chat from get_inbox for a number of hours.",
            inputSchema: { chat_id: z.string(), hours: z.number().positive().max(24 * 90) },
            annotations: LOCAL_WRITE
        },
        async ({ chat_id, hours }) => {
            const until = Date.now() + hours * 3_600_000;
            store.set({ chatGuid: chat_id, status: "snoozed", lastMessageGuid: null, snoozeUntil: until });
            return json({ ok: true, chat_id, status: "snoozed", until: new Date(until).toISOString() });
        }
    );

    server.registerTool(
        "mute_conversation",
        {
            title: "Mute conversation",
            description: "Permanently hides a chat from get_inbox (e.g. a business or noisy group) until unhidden.",
            inputSchema: { chat_id: z.string() },
            annotations: LOCAL_WRITE
        },
        async ({ chat_id }) => {
            store.set({ chatGuid: chat_id, status: "muted", lastMessageGuid: null, snoozeUntil: null });
            return json({ ok: true, chat_id, status: "muted" });
        }
    );

    server.registerTool(
        "unhide_conversation",
        {
            title: "Unhide conversation",
            description: "Undoes mark_done, snooze_conversation or mute_conversation for a chat.",
            inputSchema: { chat_id: z.string() },
            annotations: LOCAL_WRITE
        },
        async ({ chat_id }) => json({ ok: true, chat_id, was_hidden: store.clear(chat_id) })
    );

    return server;
}
