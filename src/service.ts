import type { BlueBubblesClient, BBChat, BBMessage } from "./bluebubbles.ts";
import type { TriageOptions } from "./config.ts";
import { ContactBook, normalizeAddress } from "./contacts.ts";
import { isHidden, type StateStore } from "./store.ts";
import { localIso } from "./time.ts";
import { buildReport, type ChatTriage, chatTitle, isConversational, type TriageReport, triageChat } from "./triage.ts";

const HOUR = 60 * 60 * 1000;
const CONTACTS_TTL = 6 * HOUR;
const MESSAGES_PER_CHAT = 30;
const CONCURRENCY = 6;

export class InsightsService {
    private contactsCache: { book: ContactBook; fetchedAt: number } | null = null;
    private readonly bb: BlueBubblesClient;
    private readonly opts: TriageOptions;
    private readonly store?: StateStore;

    constructor(bb: BlueBubblesClient, opts: TriageOptions, store?: StateStore) {
        this.bb = bb;
        this.opts = opts;
        this.store = store;
    }

    async contacts(): Promise<ContactBook> {
        if (this.contactsCache && Date.now() - this.contactsCache.fetchedAt < CONTACTS_TTL) {
            return this.contactsCache.book;
        }
        let book: ContactBook;
        try {
            book = new ContactBook(await this.bb.contacts());
        } catch (err) {
            // Contacts access is optional on the BlueBubbles side; triage still works on raw numbers.
            console.warn(`Could not load contacts: ${(err as Error).message}`);
            book = new ContactBook();
        }
        this.contactsCache = { book, fetchedAt: Date.now() };
        return book;
    }

    async recentChats(lookbackDays = this.opts.lookbackDays): Promise<BBChat[]> {
        const cutoff = Date.now() - lookbackDays * 24 * HOUR;
        const chats = await this.bb.listChats();
        return chats.filter(c => (c.lastMessage?.dateCreated ?? 0) >= cutoff);
    }

    async triage(opts: { includeHidden?: boolean; lookbackDays?: number } = {}): Promise<TriageReport & { hiddenCount: number }> {
        const triageOpts = { ...this.opts, lookbackDays: opts.lookbackDays ?? this.opts.lookbackDays };
        const [chats, contacts] = await Promise.all([this.recentChats(triageOpts.lookbackDays), this.contacts()]);

        const results = await mapLimit(groupSamePerson(chats), CONCURRENCY, async group => {
            const perChat = await Promise.all(group.map(c => this.bb.chatMessages(c.guid, { limit: MESSAGES_PER_CHAT })));
            const merged = perChat.flat().sort((a, b) => (b.dateCreated ?? 0) - (a.dateCreated ?? 0));
            return triageChat(group[0], merged, contacts, triageOpts);
        });

        const flagged = results.filter((r): r is ChatTriage => r !== null);
        const state = this.store?.all() ?? new Map();
        const visible = opts.includeHidden ? flagged : flagged.filter(t => !isHidden(state.get(t.chatGuid), t.lastMessageGuid));

        return { ...buildReport(visible), hiddenCount: flagged.length - visible.length };
    }

    /** Chats whose title or participants match `name` (case-insensitive), most recent first. */
    async findChats(name: string, limit = 10) {
        const [chats, contacts] = await Promise.all([this.bb.listChats(), this.contacts()]);
        const needle = name.trim().toLowerCase();
        return chats
            .filter(c => {
                const haystack = [chatTitle(c, contacts), c.chatIdentifier, ...(c.participants ?? []).map(p => p.address)];
                return haystack.some(h => h.toLowerCase().includes(needle));
            })
            .slice(0, limit)
            .map(c => ({
                chatGuid: c.guid,
                title: chatTitle(c, contacts),
                isGroup: c.style === 43,
                lastMessageAt: c.lastMessage?.dateCreated ? new Date(c.lastMessage.dateCreated).toISOString() : null,
                lastMessage: c.lastMessage?.text?.replace(/￼/g, "").trim().slice(0, 140) ?? null
            }));
    }

    /** GUID of the newest conversational message, used to tie "done" to a point in the chat. */
    async latestMessageGuid(chatGuid: string): Promise<string | null> {
        const messages = await this.bb.chatMessages(chatGuid, { limit: 10 });
        return messages.find(isConversational)?.guid ?? null;
    }

    /**
     * Messages in a chat, oldest first, optionally limited to a time window (epoch ms, both bounds exclusive):
     * - neither bound: the latest `limit` messages
     * - `after` only: the first `limit` messages after it (reading forward from a point)
     * - `before` (with or without `after`): the last `limit` messages before it
     * - `around`: about `limit / 2` messages on each side of that moment (inclusive of it)
     *
     * `limit` counts raw rows, so hiding reactions can return fewer. Page with the returned
     * `nextAfter`/`nextBefore` cursors, which come from the raw rows; a page can be all reactions.
     */
    async conversation(chatGuid: string, opts: { limit?: number; after?: number; before?: number; around?: number; includeReactions?: boolean } = {}) {
        const limit = opts.limit ?? 50;
        const contacts = await this.contacts();
        let raw: BBMessage[];
        let truncated: boolean;

        // BlueBubbles compares with >= / <=; nudge by 1ms so a cursor doesn't return its own message again.
        if (opts.around != null) {
            const half = Math.max(1, Math.ceil(limit / 2));
            const [older, newer] = await Promise.all([
                this.bb.chatMessages(chatGuid, { limit: half, before: opts.around - 1, sort: "DESC" }),
                this.bb.chatMessages(chatGuid, { limit: half, after: opts.around, sort: "ASC" })
            ]);
            raw = [...older.reverse(), ...newer];
            truncated = older.length === half || newer.length === half;
        } else {
            const after = opts.after != null ? opts.after + 1 : undefined;
            const before = opts.before != null ? opts.before - 1 : undefined;
            const forward = after != null && before == null;
            const page = await this.bb.chatMessages(chatGuid, { limit, after, before, sort: forward ? "ASC" : "DESC" });
            raw = forward ? page : page.reverse();
            truncated = page.length === limit;
        }

        const first = raw[0]?.dateCreated;
        const last = raw.at(-1)?.dateCreated;
        const shown = opts.includeReactions ? raw : raw.filter(isConversational);

        return {
            truncated,
            nextAfter: last != null ? localIso(last) : null,
            nextBefore: first != null ? localIso(first) : null,
            hiddenReactions: raw.length - shown.length,
            messages: shown.map(m => ({
                guid: m.guid,
                from: m.isFromMe ? "me" : contacts.label(m.handle?.address ?? "unknown"),
                isFromMe: m.isFromMe,
                text: m.text,
                attachments: m.attachments?.length ?? 0,
                at: m.dateCreated ? localIso(m.dateCreated) : null
            }))
        };
    }

    async search(term: string, opts: { chatGuid?: string; lookbackDays?: number; after?: number; before?: number; limit?: number } = {}) {
        const after = opts.after ?? (opts.lookbackDays ? Date.now() - opts.lookbackDays * 24 * HOUR : undefined);
        const [messages, contacts] = await Promise.all([
            this.bb.searchMessages({ term, chatGuid: opts.chatGuid, after, before: opts.before, limit: opts.limit }),
            this.contacts()
        ]);
        return messages.map(m => ({
            guid: m.guid,
            chatGuid: m.chats?.[0]?.guid ?? null,
            from: m.isFromMe ? "me" : contacts.label(m.handle?.address ?? "unknown"),
            isFromMe: m.isFromMe,
            text: m.text,
            at: m.dateCreated ? localIso(m.dateCreated) : null
        }));
    }
}

/**
 * One person often has several 1:1 chats (iMessage and SMS, phone and email).
 * Groups those so "who spoke last" is judged across all of them. Input is newest-first,
 * so each group's first chat is the most recently active one.
 */
export function groupSamePerson(chats: BBChat[]): BBChat[][] {
    const groups = new Map<string, BBChat[]>();
    for (const chat of chats) {
        const key = chat.style === 45 ? `dm:${normalizeAddress(chat.participants?.[0]?.address ?? chat.chatIdentifier)}` : `chat:${chat.guid}`;
        const existing = groups.get(key);
        if (existing) existing.push(chat);
        else groups.set(key, [chat]);
    }
    return [...groups.values()];
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return out;
}
