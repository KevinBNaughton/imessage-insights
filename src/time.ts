// Time helpers. Everything is in the Mac's local timezone, which is the user's.

/**
 * Parses a user/assistant-supplied time. A bare date ("2026-10-09") means local midnight at the start of
 * that day; anything else goes through Date.parse (ISO 8601, with or without an offset).
 */
export function parseWhen(input: string): number {
    const s = input.trim();
    const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const ms = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime() : Date.parse(s);
    if (!Number.isFinite(ms)) throw new Error(`Unrecognized date/time "${input}". Use ISO 8601, e.g. 2026-10-09 or 2026-10-09T20:30.`);
    return ms;
}

/**
 * ISO 8601 in local time with its offset, e.g. 2026-10-09T20:30:00.123-04:00. Milliseconds are kept so a
 * returned timestamp can be passed back as a precise paging cursor.
 */
export function localIso(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    const offset = -d.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
        `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}` +
        `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
    );
}
