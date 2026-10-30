// Read-only client for the BlueBubbles server REST API (/api/v1).
// Only GET endpoints and POST *query* endpoints are wrapped here on purpose:
// nothing in this file can send, edit, unsend, or delete anything.

export interface BBHandle {
    address: string;
    service?: string;
}

export interface BBMessage {
    guid: string;
    text: string | null;
    handle: BBHandle | null;
    isFromMe: boolean;
    dateCreated: number | null;
    dateRead: number | null;
    itemType?: number;
    associatedMessageType?: number | string | null;
    isSystemMessage?: boolean;
    isServiceMessage?: boolean;
    attachments?: unknown[];
    chats?: BBChat[];
}

export interface BBChat {
    guid: string;
    // 43 = group, 45 = 1:1
    style: number;
    chatIdentifier: string;
    displayName: string | null;
    isArchived?: boolean;
    participants?: BBHandle[];
    lastMessage?: BBMessage | null;
}

export interface BBContact {
    displayName?: string;
    firstName?: string;
    lastName?: string;
    phoneNumbers?: { address: string }[];
    emails?: { address: string }[];
}

interface BBEnvelope<T> {
    status: number;
    message: string;
    data: T;
    error?: { type?: string; message?: string };
}

export class BlueBubblesClient {
    private readonly baseUrl: string;
    private readonly password: string;

    constructor(opts: { url: string; password: string }) {
        this.baseUrl = opts.url;
        this.password = opts.password;
    }

    private async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
        const url = new URL(`/api/v1/${path}`, this.baseUrl);
        url.searchParams.set("password", this.password);
        for (const [k, v] of Object.entries(opts.query ?? {})) {
            if (v !== undefined) url.searchParams.set(k, String(v));
        }

        const res = await fetch(url, {
            method,
            headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
            signal: AbortSignal.timeout(30_000)
        });

        let json: BBEnvelope<T>;
        try {
            json = (await res.json()) as BBEnvelope<T>;
        } catch {
            throw new Error(`BlueBubbles ${method} ${path} returned non-JSON (HTTP ${res.status})`);
        }
        if (!res.ok) {
            // Never include the URL here: it carries the password.
            throw new Error(`BlueBubbles ${method} ${path} failed (HTTP ${res.status}): ${json.error?.message ?? json.message}`);
        }
        return json.data;
    }

    ping(): Promise<string> {
        return this.request("GET", "ping");
    }

    /** All chats, most recently active first, each with its last message and participants. */
    listChats(limit = 1000): Promise<BBChat[]> {
        return this.request("POST", "chat/query", {
            body: { with: ["lastMessage", "participants"], sort: "lastmessage", limit }
        });
    }

    /** Messages in one chat, newest first. */
    chatMessages(chatGuid: string, opts: { limit?: number; after?: number; before?: number } = {}): Promise<BBMessage[]> {
        return this.request("GET", `chat/${encodeURIComponent(chatGuid)}/message`, {
            query: { limit: opts.limit ?? 50, after: opts.after, before: opts.before, sort: "DESC", with: "handle" }
        });
    }

    /** Text search across messages. Uses a LIKE match on message text. */
    searchMessages(opts: { term: string; chatGuid?: string; after?: number; before?: number; limit?: number }): Promise<BBMessage[]> {
        return this.request("POST", "message/query", {
            body: {
                where: [{ statement: "message.text LIKE :term", args: { term: `%${opts.term}%` } }],
                chatGuid: opts.chatGuid,
                after: opts.after,
                before: opts.before,
                limit: opts.limit ?? 50,
                sort: "DESC",
                with: ["chat", "handle"]
            }
        });
    }

    contacts(): Promise<BBContact[]> {
        return this.request("GET", "contact");
    }
}
