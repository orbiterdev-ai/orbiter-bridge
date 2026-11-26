#!/usr/bin/env node

/**
 * Orbiter MCP Bridge
 * Bridges local Stdio Agents (Claude Desktop, Cursor) to Remote Orbiter Cloud via SSE.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { EventSource } = require("eventsource");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Load Environment silently so MCP stdio stdout framing is never polluted
dotenv.config({ quiet: true });

// Configuration
const CONFIG_PATH = path.join(os.homedir(), ".orbiter-config");
let config = {};
if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

const BASE_URL = (process.env.ORBITER_URL || config.url || "https://api.orbiterdev.ai").replace(/\/+$/, "");
const TOKEN = process.env.ORBITER_TOKEN || config.token;
const MACHINE_ID = process.env.ORBITER_MACHINE_ID || config.machineId || os.hostname();

function sanitizeOutput(value) {
    const text = String(value ?? "");
    if (!TOKEN) return text;
    return text.split(TOKEN).join("[redacted]");
}

if (!TOKEN) {
    console.error("Error: ORBITER_TOKEN not found. Please log in first.");
    process.exit(1);
}

// 1. Initialize MCP Server (Local side)
const server = new Server(
    {
        name: "orbiter-remote-bridge",
        version: "1.0.0",
    },
    {
        capabilities: {
            prompts: {},
            resources: {},
            tools: {},
        },
    }
);

// 2. Establish Remote SSE Connection (Cloud side) using eventsource v4 fetch option
const sseUrl = `${BASE_URL}/api/v1/mcp/sse`;
const messagesUrl = `${BASE_URL}/api/v1/mcp/messages`;

console.error(`Connecting to Orbiter Remote: ${sseUrl}`);

const es = new EventSource(sseUrl, {
    fetch: (input, init) => {
        const headers = new Headers(init && init.headers ? init.headers : undefined);
        headers.set("Authorization", `Bearer ${TOKEN}`);
        headers.set("X-Orbiter-Machine-ID", MACHINE_ID);
        return globalThis.fetch(input, {
            ...init,
            headers,
        });
    },
});

es.onerror = (err) => {
    const code = err && typeof err.code === "number" ? ` (HTTP ${err.code})` : "";
    const message = sanitizeOutput(err && err.message ? err.message : "connection error");
    console.error(`SSE Error${code}: ${message}`);
};

es.addEventListener("endpoint", (event) => {
    console.error(`Remote endpoint established: ${sanitizeOutput(event.data)}`);
});

// Proxy logic: Remote Message -> Local Stdio
es.addEventListener("message", (event) => {
    try {
        JSON.parse(event.data);
    } catch (e) {
        console.error("Failed to parse remote message:", sanitizeOutput(e && e.message ? e.message : e));
    }
});

const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

// 3. Request Handlers (Proxy to Remote)
server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
        const response = await axios.post(messagesUrl, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {}
        }, {
            headers: {
                "Authorization": `Bearer ${TOKEN}`,
                "X-Orbiter-Machine-ID": MACHINE_ID
            }
        });
        return response.data.result;
    } catch (error) {
        console.error("ListTools Remote Error:", sanitizeOutput(error && error.message ? error.message : error));
        return { tools: [] };
    }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        const response = await axios.post(messagesUrl, {
            jsonrpc: "2.0",
            id: request.id,
            method: "tools/call",
            params: request.params
        }, {
            headers: {
                "Authorization": `Bearer ${TOKEN}`,
                "X-Orbiter-Machine-ID": MACHINE_ID
            },
            timeout: 310000
        });
        return response.data.result;
    } catch (error) {
        console.error("CallTool Remote Error:", sanitizeOutput(error && error.message ? error.message : error));
        throw new Error(sanitizeOutput(error && error.message ? error.message : "Remote tool call failed"));
    }
});

function shutdown() {
    try {
        es.close();
    } catch {
        // Ignore close errors during shutdown
    }
}

process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
});
process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
});
process.stdin.on("close", shutdown);

// 4. Start Transport
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    console.error("Orbiter Bridge: Stdio Transport Active");
}).catch((err) => {
    console.error("Failed to start bridge:", sanitizeOutput(err && err.message ? err.message : err));
    shutdown();
    process.exit(1);
});
