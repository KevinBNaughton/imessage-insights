import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BlueBubblesClient } from "./bluebubbles.ts";
import { loadBlueBubblesConfig, loadServerConfig, loadTriageOptions } from "./config.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.ts";
import { InsightsService } from "./service.ts";
import { StateStore } from "./store.ts";

const serverConfig = loadServerConfig();
const store = new StateStore(serverConfig.dbPath);
const service = new InsightsService(new BlueBubblesClient(loadBlueBubblesConfig()), loadTriageOptions(), store);

class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
    const expected = Buffer.from(serverConfig.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64 * 1024) throw new HttpError(413, "Body too large");
    }
    if (!raw.trim()) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new HttpError(400, "Body must be JSON");
    }
}

function intParam(url: URL, name: string): number | undefined {
    const raw = url.searchParams.get(name);
    if (raw == null) return undefined;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
    return n;
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

async function route(req: IncomingMessage, url: URL): Promise<unknown> {
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/v1/triage") {
        return service.triage({
            lookbackDays: intParam(url, "lookbackDays"),
            includeHidden: url.searchParams.get("includeHidden") === "true"
        });
    }

    if (method === "GET" && path === "/v1/search") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) throw new HttpError(400, "q is required");
        return service.search(q, {
            chatGuid: url.searchParams.get("chatGuid") ?? undefined,
            lookbackDays: intParam(url, "lookbackDays"),
            limit: intParam(url, "limit")
        });
    }

    const chatMatch = path.match(/^\/v1\/chats\/([^/]+)\/(messages|done|snooze|mute|state)$/);
    if (chatMatch) {
        const chatGuid = decodeURIComponent(chatMatch[1]);
        const action = chatMatch[2];

        if (method === "GET" && action === "messages") {
            return service.conversation(chatGuid, Math.min(intParam(url, "limit") ?? 50, 500));
        }
        if (method === "POST" && action === "done") {
            const body = await readJson(req);
            const lastMessageGuid = typeof body.lastMessageGuid === "string" ? body.lastMessageGuid : await service.latestMessageGuid(chatGuid);
            return store.set({ chatGuid, status: "done", lastMessageGuid, snoozeUntil: null });
        }
        if (method === "POST" && action === "snooze") {
            const body = await readJson(req);
            const until =
                typeof body.until === "string" ? Date.parse(body.until) : typeof body.hours === "number" ? Date.now() + body.hours * 3_600_000 : NaN;
            if (!Number.isFinite(until) || until <= Date.now()) throw new HttpError(400, "Provide a future `until` (ISO date) or positive `hours`");
            return store.set({ chatGuid, status: "snoozed", lastMessageGuid: null, snoozeUntil: until });
        }
        if (method === "POST" && action === "mute") {
            return store.set({ chatGuid, status: "muted", lastMessageGuid: null, snoozeUntil: null });
        }
        if (method === "DELETE" && action === "state") {
            return { cleared: store.clear(chatGuid) };
        }
    }

    throw new HttpError(404, "Not found");
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/health") return send(res, 200, { ok: true });
    // Clients probe these for OAuth discovery; a 404 tells them this server uses a static token instead.
    if (url.pathname.startsWith("/.well-known/")) return send(res, 404, { error: "Not found" });
    if (!authorized(req)) return send(res, 401, { error: "Unauthorized" });

    if (url.pathname === "/mcp") {
        if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
        try {
            // Stateless: a fresh server and transport per request, so nothing needs to survive between calls.
            const mcp = createMcpServer(service, store);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            res.on("close", () => {
                transport.close();
                mcp.close();
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res, await readJson(req));
        } catch (err) {
            console.error(err);
            if (!res.headersSent) send(res, err instanceof HttpError ? err.status : 500, { error: (err as Error).message });
        }
        return;
    }

    try {
        send(res, 200, await route(req, url));
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 502;
        if (status >= 500) console.error(err);
        send(res, status, { error: (err as Error).message });
    }
});

server.listen(serverConfig.port, serverConfig.host, () => {
    console.log(`imessage-insights listening on http://${serverConfig.host}:${serverConfig.port}`);
});
