import assert from "node:assert/strict";
import { it } from "node:test";
import { type BBChat, buildTextSearchWhere } from "../src/bluebubbles.ts";
import { groupSamePerson } from "../src/service.ts";

it("groups a person's iMessage and SMS threads, newest chat first", () => {
    const chat = (guid: string, style: number, address: string): BBChat => ({ guid, style, chatIdentifier: address, displayName: null, participants: [{ address }] });
    const groups = groupSamePerson([
        chat("iMessage;-;+19045550001", 45, "+19045550001"),
        chat("iMessage;+;chat1", 43, "+19045550001"),
        chat("SMS;-;+19045550001", 45, "9045550001")
    ]);
    assert.deepEqual(groups.map(g => g.map(c => c.guid)), [["iMessage;-;+19045550001", "SMS;-;+19045550001"], ["iMessage;+;chat1"]]);
});

it("builds a text search that avoids BlueBubbles' Private API reroute and searches attributedBody", () => {
    const where = buildTextSearchWhere("dinner");
    assert.ok(!where.statement.includes("message.text"), "literal message.text triggers the Spotlight reroute");
    assert.match(where.statement, /instr\(message\.attributedBody/);
    assert.deepEqual(Object.values(where.args).sort(), ["%dinner%", "DINNER", "Dinner", "dinner"].sort());
});
