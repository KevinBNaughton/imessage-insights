function required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
    return value;
}

function num(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw == null || raw.trim() === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${raw}"`);
    return n;
}

export interface TriageOptions {
    lookbackDays: number;
    needsReplyMinAgeHours: number;
    waitingMinAgeHours: number;
    myNames: string[];
}

export function loadBlueBubblesConfig() {
    return {
        url: required("BLUEBUBBLES_URL").replace(/\/+$/, ""),
        password: required("BLUEBUBBLES_PASSWORD")
    };
}

export function loadTriageOptions(): TriageOptions {
    return {
        lookbackDays: num("LOOKBACK_DAYS", 14),
        needsReplyMinAgeHours: num("NEEDS_REPLY_MIN_AGE_HOURS", 1),
        waitingMinAgeHours: num("WAITING_MIN_AGE_HOURS", 48),
        myNames: (process.env.MY_NAMES ?? "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
    };
}

export function loadDbPath(): string {
    return process.env.DB_PATH?.trim() || "./insights.db";
}

export function loadServerConfig() {
    const token = required("INSIGHTS_TOKEN");
    if (token.length < 24) throw new Error("INSIGHTS_TOKEN must be at least 24 characters");
    return {
        token,
        host: process.env.HOST?.trim() || "127.0.0.1",
        port: num("PORT", 8787),
        dbPath: loadDbPath()
    };
}
