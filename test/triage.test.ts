import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BBChat, BBMessage } from "../src/bluebubbles.ts";
import type { TriageOptions } from "../src/config.ts";
import { ContactBook, normalizeAddress } from "../src/contacts.ts";
import { isHidden } from "../src/store.ts";
import { buildReport, isConversational, triageChat } from "../src/triage.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const HOUR = 3_600_000;
const opts: TriageOptions = { lookbackDays: 14, needsReplyMinAgeHours: 1, waitingMinAgeHours: 48, myNames: ["Kevin"] };

const ALICE = "+15551234567";
const BOB = "bob@example.com";
const contacts = new ContactBook([
    { displayName: "Alice Smith", phoneNumbers: [{ address: "(555) 123-4567" }] },
    { firstName: "Bob", lastName: "Jones", emails: [{ address: BOB }] }
]);

let seq = 0;
function msg(hoursAgo: number, text: string, from: string | "me", extra: Partial<BBMessage> = {}): BBMessage {
    return {
        guid: `m${++seq}`,
        text,
        isFromMe: from === "me",
        handle: from === "me" ? null : { address: from },
        dateCreated: NOW - hoursAgo * HOUR,
        dateRead: null,
        itemType: 0,
        associatedMessageType: 0,
        ...extra
    };
}

function dm(address: string): BBChat {
    return { guid: `iMessage;-;${address}`, style: 45, chatIdentifier: address, displayName: null, participants: [{ address }] };
}

function group(...addresses: string[]): BBChat {
    return { guid: "iMessage;+;chat123", style: 43, chatIdentifier: "chat123", displayName: "Weekend crew", participants: addresses.map(address => ({ address })) };
}

// Messages are passed newest-first, matching the BlueBubbles API order.
const newestFirst = (...ms: BBMessage[]) => ms.sort((a, b) => (b.dateCreated ?? 0) - (a.dateCreated ?? 0));

describe("contacts", () => {
    it("matches phone numbers regardless of formatting", () => {
        assert.equal(normalizeAddress("+1 (555) 123-4567"), normalizeAddress("5551234567"));
        assert.equal(contacts.nameFor(ALICE), "Alice Smith");
        assert.equal(contacts.nameFor("BOB@example.com"), "Bob Jones");
        assert.equal(contacts.nameFor("+15550000000"), null);
    });
});

describe("isConversational", () => {
    it("drops tapbacks, system rows and empty messages", () => {
        assert.equal(isConversational(msg(1, "hi", ALICE)), true);
        assert.equal(isConversational(msg(1, "Loved “hi”", ALICE, { associatedMessageType: 2000 })), false);
        assert.equal(isConversational(msg(1, "", ALICE, { itemType: 2 })), false);
        assert.equal(isConversational(msg(1, "￼", ALICE)), false);
        assert.equal(isConversational(msg(1, "￼", ALICE, { attachments: [{}] })), true);
    });
});

describe("triageChat", () => {
    it("flags a DM where they sent the last message", () => {
        const t = triageChat(dm(ALICE), newestFirst(msg(10, "hey", "me"), msg(5, "are you coming saturday?", ALICE)), contacts, opts, NOW);
        assert.equal(t?.bucket, "needsReply");
        assert.equal(t?.reason, "They asked you a question");
        assert.equal(t?.title, "Alice Smith");
        assert.equal(t?.unansweredCount, 1);
    });

    it("ignores a trailing tapback from them when I replied last", () => {
        const t = triageChat(
            dm(ALICE),
            newestFirst(msg(5, "sounds good", "me"), msg(4, "Liked “sounds good”", ALICE, { associatedMessageType: 2001 })),
            contacts,
            opts,
            NOW
        );
        assert.equal(t, null);
    });

    it("does not flag very fresh messages", () => {
        assert.equal(triageChat(dm(ALICE), [msg(0.2, "yo", ALICE)], contacts, opts, NOW), null);
    });

    it("does not flag chats older than the lookback window", () => {
        assert.equal(triageChat(dm(ALICE), [msg(24 * 20, "yo", ALICE)], contacts, opts, NOW), null);
    });

    it("skips OTP codes and short codes", () => {
        assert.equal(triageChat(dm("+15550001111"), [msg(3, "Your verification code is 482913", "+15550001111")], contacts, opts, NOW), null);
        assert.equal(triageChat(dm("72975"), [msg(3, "Your package was delivered", "72975")], contacts, opts, NOW), null);
    });

    it("puts first-contact strangers in unknownSender", () => {
        const t = triageChat(dm("+15559998888"), [msg(3, "Hi, is this still available?", "+15559998888")], contacts, opts, NOW);
        assert.equal(t?.bucket, "unknownSender");
    });

    it("treats a stranger I've talked to before as needsReply", () => {
        const t = triageChat(dm("+15559998888"), newestFirst(msg(30, "sure", "me"), msg(3, "ok thanks", "+15559998888")), contacts, opts, NOW);
        assert.equal(t?.bucket, "needsReply");
    });

    it("only flags group chats on a question or mention", () => {
        const chat = group(ALICE, BOB);
        assert.equal(triageChat(chat, newestFirst(msg(10, "lol", "me"), msg(5, "haha nice", ALICE)), contacts, opts, NOW), null);

        const asked = triageChat(chat, newestFirst(msg(10, "lol", "me"), msg(5, "who's driving?", BOB)), contacts, opts, NOW);
        assert.equal(asked?.bucket, "needsReply");

        const mentioned = triageChat(chat, newestFirst(msg(10, "lol", "me"), msg(5, "kevin will know", BOB)), contacts, opts, NOW);
        assert.equal(mentioned?.reason, "You were mentioned in the group");
    });

    it("flags my unanswered question after the waiting threshold", () => {
        const early = triageChat(dm(BOB), newestFirst(msg(50, "hi", BOB), msg(24, "did you send the invoice?", "me")), contacts, opts, NOW);
        assert.equal(early, null);

        const t = triageChat(dm(BOB), newestFirst(msg(80, "hi", BOB), msg(60, "did you send the invoice?", "me")), contacts, opts, NOW);
        assert.equal(t?.bucket, "waitingOnThem");
    });

    it("does not flag my last message when it isn't a question", () => {
        assert.equal(triageChat(dm(BOB), newestFirst(msg(80, "thanks!", BOB), msg(60, "no problem", "me")), contacts, opts, NOW), null);
    });
});

describe("buildReport", () => {
    it("sorts each bucket longest-waiting first within a priority", () => {
        const a = triageChat(dm(ALICE), [msg(5, "hey", ALICE)], contacts, opts, NOW)!;
        const b = triageChat(dm(BOB), [msg(50, "hey", BOB)], contacts, opts, NOW)!;
        const report = buildReport([a, b], NOW);
        assert.deepEqual(report.needsReply.map(t => t.title), ["Bob Jones", "Alice Smith"]);
    });
});

describe("isHidden", () => {
    it("hides done chats until a newer message arrives", () => {
        const state = { chatGuid: "c", status: "done" as const, lastMessageGuid: "m1", snoozeUntil: null, updatedAt: NOW };
        assert.equal(isHidden(state, "m1", NOW), true);
        assert.equal(isHidden(state, "m2", NOW), false);
    });

    it("hides snoozed chats until the snooze expires", () => {
        const state = { chatGuid: "c", status: "snoozed" as const, lastMessageGuid: null, snoozeUntil: NOW + HOUR, updatedAt: NOW };
        assert.equal(isHidden(state, "m1", NOW), true);
        assert.equal(isHidden(state, "m1", NOW + 2 * HOUR), false);
    });
});

describe("noise filtering (from real-data review)", () => {
    it("routes business texts to automated even if I replied before", () => {
        const t = triageChat(
            dm("+16465586696"),
            newestFirst(msg(30, "C", "me"), msg(20, "Don't forget to read your messages. Click the link to READ: https://x.co", "+16465586696")),
            contacts,
            opts,
            NOW
        );
        assert.equal(t?.bucket, "automated");
        assert.equal(triageChat(dm("+18883390913"), [msg(5, "Transaction declined", "+18883390913")], contacts, opts, NOW)?.bucket, "automated");
    });

    it("marks conversation enders as low priority", () => {
        for (const text of ["thank you", "Yes lol", "Rip", "That’s so cute bro", "haha", "😂😂"]) {
            const t = triageChat(dm(ALICE), newestFirst(msg(30, "hey", "me"), msg(20, text, ALICE)), contacts, opts, NOW);
            assert.equal(t?.priority, "low", text);
        }
        const real = triageChat(dm(ALICE), newestFirst(msg(30, "hey", "me"), msg(20, "soon I’ll also be in FL haha", ALICE)), contacts, opts, NOW);
        assert.equal(real?.priority, "normal");
    });

    it("sorts high priority before older low priority", () => {
        const low = triageChat(dm(ALICE), newestFirst(msg(90, "hey", "me"), msg(80, "thanks", ALICE)), contacts, opts, NOW)!;
        const high = triageChat(dm(BOB), newestFirst(msg(9, "hey", "me"), msg(5, "free friday?", BOB)), contacts, opts, NOW)!;
        assert.deepEqual(buildReport([low, high], NOW).needsReply.map(t => t.title), ["Bob Jones", "Alice Smith"]);
    });
});
