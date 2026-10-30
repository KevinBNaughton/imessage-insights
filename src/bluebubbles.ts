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

/**
 * Builds the `where` clause for a text search, working around two BlueBubbles/macOS behaviors:
 *
 * - On Ventura+ with the Private API enabled, BlueBubbles reroutes any statement containing the
 *   literal "message.text" to a Spotlight search through the helper, which can hang indefinitely.
 *   Writing the column as message."text" is the same SQL but skips that reroute.
 * - Newer macOS often leaves message.text NULL and stores the text only inside the attributedBody
 *   blob. CAST(blob AS TEXT) stops at the blob's first NUL byte, so we byte-search it with instr()
 *   instead. That match is case-sensitive, so a few common casings of the term are tried.
 */
export function buildTextSearchWhere(term: string): { statement: string; args: Record<string, string> } {
    const casings = new Set([term, term.toLowerCase(), term.toUpperCase(), term.charAt(0).toUpperCase() + term.slice(1).toLowerCase()]);
    const args: Record<string, string> = { like: `%${term}%` };
    const clauses = ['message."text" LIKE :like'];
    [...casings].forEach((casing, i) => {
        args[`blob${i}`] = casing;
        clauses.push(`instr(message.attributedBody, CAST(:blob${i} AS BLOB)) > 0`);
    });
    return { statement: `(${clauses.join(" OR ")})`, args };
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

    /**
     * All chats, most recently active first, each with its last message and participants.
     * BlueBubbles caps a page at 1000 and its "lastmessage" ordering is unreliable (a chat with a message
     * from today can land thousands of rows down), so page through everything and sort here.
     */
    async listChats(pageSize = 1000): Promise<BBChat[]> {
        const all: BBChat[] = [];
        for (let offset = 0; ; offset += pageSize) {
            const page = await this.request<BBChat[]>("POST", "chat/query", {
                body: { with: ["lastMessage", "participants"], sort: "lastmessage", limit: pageSize, offset }
            });
            all.push(...page);
            if (page.length < pageSize) break;
        }
        return all.sort((a, b) => (b.lastMessage?.dateCreated ?? 0) - (a.lastMessage?.dateCreated ?? 0));
    }

    /** Messages in one chat, newest first unless sort is "ASC". after/before are epoch ms. */
    chatMessages(chatGuid: string, opts: { limit?: number; after?: number; before?: number; sort?: "ASC" | "DESC" } = {}): Promise<BBMessage[]> {
        return this.request("GET", `chat/${encodeURIComponent(chatGuid)}/message`, {
            query: { limit: opts.limit ?? 50, after: opts.after, before: opts.before, sort: opts.sort ?? "DESC", with: "handle" }
        });
    }

    /** Text search across messages, newest first. See buildTextSearchWhere for why the query looks the way it does. */
    searchMessages(opts: { term: string; chatGuid?: string; after?: number; before?: number; limit?: number }): Promise<BBMessage[]> {
        return this.request("POST", "message/query", {
            body: {
                where: [buildTextSearchWhere(opts.term)],
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
