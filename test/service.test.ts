import assert from "node:assert/strict";
import { it } from "node:test";
import type { BBChat } from "../src/bluebubbles.ts";
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
