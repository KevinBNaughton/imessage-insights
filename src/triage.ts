import type { BBChat, BBMessage } from "./bluebubbles.ts";
import type { TriageOptions } from "./config.ts";
import { type ContactBook, isShortCode, normalizeAddress } from "./contacts.ts";

const HOUR = 60 * 60 * 1000;

export type Bucket = "needsReply" | "waitingOnThem" | "unknownSender" | "automated";

/** high: question or mention. low: the last thing they said was a conversation-ender ("thanks!", "lol"). */
export type Priority = "high" | "normal" | "low";

export interface TriageMessage {
    from: string;
    isFromMe: boolean;
    text: string;
    at: string;
}

export interface ChatTriage {
    chatGuid: string;
    title: string;
    isGroup: boolean;
    bucket: Bucket;
    priority: Priority;
    /** Short, human-readable reason this chat was flagged. */
    reason: string;
    lastMessageGuid: string;
    lastMessageAt: string;
    hoursSinceLastMessage: number;
    /** Incoming messages since you last spoke in this chat. */
    unansweredCount: number;
    /** Oldest-first slice of the conversation tail, for context. */
    recent: TriageMessage[];
}

const OTP_PATTERN = /\b(code|passcode|verification|verify|one[- ]time|otp|2fa|security code)\b/i;

// Phrases that only show up in machine-sent texts: marketing, reminders, voicemail-to-text, receipts.
const AUTOMATED_PATTERN =
    /\b(reply stop|text stop|stop to (opt[- ]?out|unsubscribe|end)|msg ?& ?data|message and data rates|do not reply|automated (text|message)|deposited a new message|click (here|the link)|unsubscribe|opt[- ]out)\b|\[automated/i;

const TOLL_FREE = /^(800|833|844|855|866|877|888)\d{7}$/;

// Short replies that close a thread rather than ask for a response.
const ACK_PATTERN =
    /^(thanks?( you| u)?( so much)?|ty|tysm|thx|ok(ay)?|kk?|cool|nice|great|perfect|sounds good|got it|will do|np|no worries|of course|yes|yep|yeah|ya|no|nope|lol|lmao|haha+|hehe|rip|same|bet|for sure|love (it|that|you)|that'?s (so )?(cute|funny|awesome|great|amazing)( bro| man| dude)?|gn|good ?night|you too|u too|safe travels.*)[\s!.,]*(lol|haha+|bro|man|dude)?[\s!.]*$/i;

/** Tapbacks, reactions, edits-in-place, group renames and other non-conversational rows. */
export function isConversational(m: BBMessage): boolean {
    if (m.itemType && m.itemType !== 0) return false;
    if (m.isSystemMessage || m.isServiceMessage) return false;
    const assoc = m.associatedMessageType;
    if (assoc != null && assoc !== 0 && assoc !== "0" && assoc !== "") return false;
    const hasText = cleanText(m).length > 0;
    return hasText || (m.attachments?.length ?? 0) > 0;
}

function cleanText(m: BBMessage): string {
    return (m.text ?? "").replace(/￼/g, "").trim();
}

export function looksLikeOtp(text: string): boolean {
    return OTP_PATTERN.test(text) && /\b\d{4,8}\b/.test(text);
}

export function looksAutomated(text: string, sender: string): boolean {
    return AUTOMATED_PATTERN.test(text) || TOLL_FREE.test(normalizeAddress(sender));
}

export function isAcknowledgment(text: string): boolean {
    // iPhones send curly apostrophes by default
    const t = text.trim().replace(/[‘’]/g, "'");
    if (!t) return false;
    // Emoji-only replies
    if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u.test(t) && !/^\d+$/.test(t)) return true;
    return ACK_PATTERN.test(t);
}

function displayText(m: BBMessage): string {
    const text = cleanText(m);
    if (text) return text;
    const n = m.attachments?.length ?? 0;
    return n > 0 ? `[${n} attachment${n === 1 ? "" : "s"}]` : "";
}

function asksQuestion(text: string): boolean {
    return /\?\s*$|\?\s/.test(text);
}

function mentionsMe(text: string, myNames: string[]): boolean {
    return myNames.some(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
}

function chatTitle(chat: BBChat, contacts: ContactBook): string {
    if (chat.displayName) return chat.displayName;
    const people = (chat.participants ?? []).map(p => contacts.label(p.address));
    if (people.length > 0) return people.join(", ");
    return contacts.label(chat.chatIdentifier);
}

/**
 * Decides whether a chat needs attention, from its newest-first message tail.
 * Returns null when nothing is owed in either direction.
 */
export function triageChat(chat: BBChat, messagesNewestFirst: BBMessage[], contacts: ContactBook, opts: TriageOptions, now = Date.now()): ChatTriage | null {
    const convo = messagesNewestFirst.filter(isConversational).filter(m => m.dateCreated != null);
    const last = convo[0];
    if (!last) return null;

    const isGroup = chat.style === 43;
    const ageHours = (now - (last.dateCreated as number)) / HOUR;
    if (ageHours > opts.lookbackDays * 24) return null;

    const lastMineIdx = convo.findIndex(m => m.isFromMe);
    const unanswered = lastMineIdx === -1 ? convo : convo.slice(0, lastMineIdx);
    const recent = convo.slice(0, 8).reverse().map(m => ({
        from: m.isFromMe ? "me" : contacts.label(m.handle?.address ?? chat.chatIdentifier),
        isFromMe: m.isFromMe,
        text: displayText(m),
        at: new Date(m.dateCreated as number).toISOString()
    }));

    const base = {
        chatGuid: chat.guid,
        title: chatTitle(chat, contacts),
        isGroup,
        lastMessageGuid: last.guid,
        lastMessageAt: new Date(last.dateCreated as number).toISOString(),
        hoursSinceLastMessage: Math.round(ageHours * 10) / 10,
        unansweredCount: unanswered.length,
        recent
    };

    if (!last.isFromMe) {
        const sender = last.handle?.address ?? chat.chatIdentifier;
        if (isShortCode(sender) || unanswered.every(m => looksLikeOtp(m.text ?? ""))) return null;
        if (ageHours < opts.needsReplyMinAgeHours) return null;

        if (!isGroup && unanswered.some(m => looksAutomated(m.text ?? "", sender))) {
            return { ...base, bucket: "automated", priority: "low", reason: "Looks like an automated or business text" };
        }

        if (isGroup) {
            // Group chats are noisy: only flag when someone addressed you or asked a question
            // since you last spoke.
            const addressed = unanswered.find(m => mentionsMe(m.text ?? "", opts.myNames));
            const asked = unanswered.find(m => asksQuestion(m.text ?? ""));
            if (!addressed && !asked) return null;
            return {
                ...base,
                bucket: "needsReply",
                priority: addressed ? "high" : "normal",
                reason: addressed ? "You were mentioned in the group" : "Question in the group since you last replied"
            };
        }

        if (!contacts.isKnown(sender) && lastMineIdx === -1) {
            return { ...base, bucket: "unknownSender", priority: "normal", reason: "Message from someone not in your contacts" };
        }

        const question = unanswered.find(m => asksQuestion(m.text ?? ""));
        if (question) return { ...base, bucket: "needsReply", priority: "high", reason: "They asked you a question" };
        if (unanswered.every(m => isAcknowledgment(cleanText(m)))) {
            return { ...base, bucket: "needsReply", priority: "low", reason: "They closed the thread (\"thanks\", \"lol\"), probably no reply needed" };
        }
        return { ...base, bucket: "needsReply", priority: "normal", reason: "They sent the last message" };
    }

    // Last message is mine: are they sitting on a question I asked?
    if (!isGroup && asksQuestion(last.text ?? "") && ageHours >= opts.waitingMinAgeHours) {
        return { ...base, bucket: "waitingOnThem", priority: "normal", reason: "You asked a question and haven't heard back" };
    }

    return null;
}

export interface TriageReport {
    generatedAt: string;
    needsReply: ChatTriage[];
    waitingOnThem: ChatTriage[];
    unknownSender: ChatTriage[];
    automated: ChatTriage[];
}

const PRIORITY_RANK: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

export function buildReport(items: ChatTriage[], now = Date.now()): TriageReport {
    // Highest priority first; within a priority, the longest-waiting person is the most overdue.
    const order = (a: ChatTriage, b: ChatTriage) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.hoursSinceLastMessage - a.hoursSinceLastMessage;
    const bucket = (name: Bucket) => items.filter(i => i.bucket === name).sort(order);
    return {
        generatedAt: new Date(now).toISOString(),
        needsReply: bucket("needsReply"),
        waitingOnThem: bucket("waitingOnThem"),
        unknownSender: bucket("unknownSender"),
        automated: bucket("automated")
    };
}
