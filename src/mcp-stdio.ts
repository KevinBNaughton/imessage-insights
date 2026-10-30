// Local MCP server over stdio, for Claude Desktop / Claude Code on this Mac.
// stdout carries the protocol, so all logging must go to stderr.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BlueBubblesClient } from "./bluebubbles.ts";
import { loadBlueBubblesConfig, loadDbPath, loadTriageOptions } from "./config.ts";
import { createMcpServer } from "./mcp.ts";
import { InsightsService } from "./service.ts";
import { StateStore } from "./store.ts";

console.log = console.error;

// MCP clients launch this from an arbitrary cwd: anchor .env and the relative DB_PATH to the repo.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
process.chdir(repoRoot);
if (existsSync(".env")) process.loadEnvFile(".env");

const store = new StateStore(loadDbPath());
const service = new InsightsService(new BlueBubblesClient(loadBlueBubblesConfig()), loadTriageOptions(), store);
await createMcpServer(service, store).connect(new StdioServerTransport());
