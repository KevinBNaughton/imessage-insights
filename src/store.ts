import { DatabaseSync } from "node:sqlite";

// Local triage state. This never touches iMessage: marking a chat "done" here
// only hides it from this service's reports.

export type ChatStatus = "done" | "snoozed" | "muted";

export interface ChatState {
    chatGuid: string;
    status: ChatStatus;
    /** For "done": the chat reappears once a newer message arrives. */
    lastMessageGuid: string | null;
    /** For "snoozed": epoch ms when it reappears. */
    snoozeUntil: number | null;
    updatedAt: number;
}

interface Row {
    chat_guid: string;
    status: ChatStatus;
    last_message_guid: string | null;
    snooze_until: number | null;
    updated_at: number;
}

export class StateStore {
    private readonly db: DatabaseSync;

    constructor(path: string) {
        this.db = new DatabaseSync(path);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS chat_state (
                chat_guid TEXT PRIMARY KEY,
                status TEXT NOT NULL CHECK (status IN ('done', 'snoozed', 'muted')),
                last_message_guid TEXT,
                snooze_until INTEGER,
                updated_at INTEGER NOT NULL
            )
        `);
    }

    all(): Map<string, ChatState> {
        const rows = this.db.prepare("SELECT * FROM chat_state").all() as unknown as Row[];
        return new Map(rows.map(r => [r.chat_guid, toState(r)]));
    }

    set(state: Omit<ChatState, "updatedAt">): ChatState {
        const updatedAt = Date.now();
        this.db
            .prepare(
                `INSERT INTO chat_state (chat_guid, status, last_message_guid, snooze_until, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(chat_guid) DO UPDATE SET
                    status = excluded.status,
                    last_message_guid = excluded.last_message_guid,
                    snooze_until = excluded.snooze_until,
                    updated_at = excluded.updated_at`
            )
            .run(state.chatGuid, state.status, state.lastMessageGuid, state.snoozeUntil, updatedAt);
        return { ...state, updatedAt };
    }

    clear(chatGuid: string): boolean {
        return this.db.prepare("DELETE FROM chat_state WHERE chat_guid = ?").run(chatGuid).changes > 0;
    }
}

function toState(r: Row): ChatState {
    return {
        chatGuid: r.chat_guid,
        status: r.status,
        lastMessageGuid: r.last_message_guid,
        snoozeUntil: r.snooze_until,
        updatedAt: r.updated_at
    };
}

/** Whether saved state should hide a chat whose newest message is `lastMessageGuid`. */
export function isHidden(state: ChatState | undefined, lastMessageGuid: string, now = Date.now()): boolean {
    if (!state) return false;
    switch (state.status) {
        case "muted":
            return true;
        case "snoozed":
            return state.snoozeUntil != null && state.snoozeUntil > now;
        case "done":
            return state.lastMessageGuid === lastMessageGuid;
    }
}
