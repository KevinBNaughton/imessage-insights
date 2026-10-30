import assert from "node:assert/strict";
import { it } from "node:test";
import { localIso, parseWhen } from "../src/time.ts";

it("parses a bare date as local midnight", () => {
    const ms = parseWhen("2026-10-09");
    const d = new Date(ms);
    assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 9, 9, 0, 0]);
});

it("parses ISO times with and without offsets", () => {
    assert.equal(parseWhen("2026-10-10T00:30:00Z"), Date.UTC(2026, 9, 10, 0, 30));
    assert.equal(parseWhen("2026-10-09T20:30"), new Date(2026, 9, 9, 20, 30).getTime());
});

it("rejects garbage", () => {
    assert.throws(() => parseWhen("last tuesday"), /Unrecognized/);
});

it("round-trips through localIso", () => {
    const ms = Date.UTC(2026, 9, 10, 0, 30, 15, 427);
    const iso = localIso(ms);
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(Date.parse(iso), ms);
});
