// Terminal front end for triage.
//
//   npm run triage                 numbered report (add --all to include automated, --json for raw output)
//   npm run triage -- done 3 5     handled: hide until they send something new
//   npm run triage -- mute 4       never show this chat again (businesses, noisy groups)
//   npm run triage -- snooze 6 48  hide for 48 hours (default 24)
//   npm run triage -- undo 4       clear done/mute/snooze (list with --include-hidden to number hidden chats)
//
// Numbers refer to the most recent report, which is saved next to the database.
import { readFileSync, writeFileSync } from "node:fs";
import { BlueBubblesClient } from "./bluebubbles.ts";
import { loadBlueBubblesConfig, loadDbPath, loadTriageOptions } from "./config.ts";
import { InsightsService } from "./service.ts";
import { isHidden, StateStore } from "./store.ts";
import type { ChatTriage } from "./triage.ts";

interface SavedItem {
    chatGuid: string;
    lastMessageGuid: string;
    title: string;
}

const store = new StateStore(loadDbPath());
const lastReportPath = `${loadDbPath()}.last-report.json`;
const [command, ...args] = process.argv.slice(2).filter(a => !a.startsWith("--"));

if (command && command !== "list") {
    let saved: Record<string, SavedItem>;
    try {
        saved = JSON.parse(readFileSync(lastReportPath, "utf8"));
    } catch {
        console.error("No saved report yet. Run `npm run triage` first.");
        process.exit(1);
    }

    const pick = (n: string): SavedItem => {
        const item = saved[n];
        if (!item) {
            console.error(`No item #${n} in the last report.`);
            process.exit(1);
        }
        return item;
    };

    switch (command) {
        case "done":
            for (const n of args) {
                const item = pick(n);
                store.set({ chatGuid: item.chatGuid, status: "done", lastMessageGuid: item.lastMessageGuid, snoozeUntil: null });
                console.log(`✓ #${n} ${item.title}: done (comes back if they message again)`);
            }
            break;
        case "mute":
            for (const n of args) {
                const item = pick(n);
                store.set({ chatGuid: item.chatGuid, status: "muted", lastMessageGuid: null, snoozeUntil: null });
                console.log(`✓ #${n} ${item.title}: muted`);
            }
            break;
        case "snooze": {
            const [n, hoursArg] = args;
            const hours = hoursArg ? Number(hoursArg) : 24;
            if (!n || !Number.isFinite(hours) || hours <= 0) {
                console.error("Usage: npm run triage -- snooze <number> [hours]");
                process.exit(1);
            }
            const item = pick(n);
            const until = Date.now() + hours * 3_600_000;
            store.set({ chatGuid: item.chatGuid, status: "snoozed", lastMessageGuid: null, snoozeUntil: until });
            console.log(`✓ #${n} ${item.title}: snoozed until ${new Date(until).toLocaleString()}`);
            break;
        }
        case "undo":
            for (const n of args) {
                const item = pick(n);
                console.log(store.clear(item.chatGuid) ? `✓ #${n} ${item.title}: restored` : `#${n} ${item.title} wasn't hidden`);
            }
            break;
        default:
            console.error(`Unknown command "${command}". Use done, mute, snooze or undo.`);
            process.exit(1);
    }
    process.exit(0);
}

const service = new InsightsService(new BlueBubblesClient(loadBlueBubblesConfig()), loadTriageOptions(), store);
const report = await service.triage({ includeHidden: process.argv.includes("--include-hidden") });

if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
}

const states = store.all();
const saved: Record<string, SavedItem> = {};
let counter = 0;
const section = (title: string, items: ChatTriage[]) => {
    console.log(`\n${title} (${items.length})`);
    for (const t of items) {
        const n = String(++counter);
        saved[n] = { chatGuid: t.chatGuid, lastMessageGuid: t.lastMessageGuid, title: t.title };
        const last = t.recent.at(-1);
        const tag = t.priority === "high" ? "!! " : t.priority === "low" ? "·· " : "";
        const state = states.get(t.chatGuid);
        const hidden = state && isHidden(state, t.lastMessageGuid) ? ` [${state.status}]` : "";
        console.log(`  ${n.padStart(2)}. ${tag}${t.title}${hidden}: ${t.reason}, ${t.hoursSinceLastMessage}h ago`);
        if (last) console.log(`        ${last.from}: ${last.text.replace(/\s+/g, " ").slice(0, 100)}`);
    }
};
section("Needs your reply", report.needsReply);
section("Waiting on them", report.waitingOnThem);
section("Unknown senders", report.unknownSender);
if (process.argv.includes("--all")) section("Automated / business", report.automated);
else console.log(`\nAutomated / business: ${report.automated.length} hidden (use --all to show)`);
if (report.hiddenCount > 0) console.log(`Done / muted / snoozed: ${report.hiddenCount} hidden (use --include-hidden to see and undo them)`);
console.log("\nMark items with: npm run triage -- done <n> | mute <n> | snooze <n> [hours] | undo <n>");

writeFileSync(lastReportPath, JSON.stringify(saved));
