#!/usr/bin/env node

/**
 * Orbiter MCP Bridge
 * Bridges local Stdio Agents (Claude Desktop, Cursor) to Remote Orbiter Cloud via SSE.
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const EventSource = require("eventsource");
const axios = require("axios");
const dotenv = require("dotenv");
const path = require("path");
const os = require("os");
const fs = require("fs");

// Load Environment
dotenv.config();

// Configuration
const CONFIG_PATH = path.join(os.homedir(), ".orbiter-config");
let config = {};
if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

const BASE_URL = process.env.ORBITER_URL || config.url || "https://api.orbiterdev.ai";
const TOKEN = process.env.ORBITER_TOKEN || config.token;
const MACHINE_ID = process.env.ORBITER_MACHINE_ID || config.machineId || os.hostname();

if (!TOKEN) {
    console.error("❌ Error: ORBITER_TOKEN not found. Please log in first.");
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

// 2. Establish Remote SSE Connection (Cloud side)
const sseUrl = `${BASE_URL}/api/v1/mcp/sse`;
const messagesUrl = `${BASE_URL}/api/v1/mcp/messages`;

console.error(`🔌 Connecting to Orbiter Remote: ${sseUrl}`);

const es = new EventSource(sseUrl, {
    headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "X-Orbiter-Machine-ID": MACHINE_ID
    }
});

es.onerror = (err) => {
    console.error("❌ SSE Error:", err);
};

es.addEventListener("endpoint", (event) => {
    console.error(`✅ Remote endpoint established: ${event.data}`);
});

// Proxy logic: Remote Message -> Local Stdio
es.addEventListener("message", (event) => {
    try {
        const msg = JSON.parse(event.data);
        // This is a bit tricky: We typically want the remote to act as a tool provider.
        // But in this bridge model, the LOCAL agent calls the BRIDGE.
        // The BRIDGE calls the REMOTE (via HTTP POST).
        // The REMOTE responds (either via HTTP response OR via SSE if async).

        // If the remote sends a push via SSE, it's likely a notification.
        // For MCP Stdio, we usually only respond to requests.
    } catch (e) {
        console.error("Failed to parse remote message", e);
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
        console.error("❌ ListTools Remote Error:", error.message);
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
        console.error("❌ CallTool Remote Error:", error.message);
        throw error;
    }
});

// 4. Start Transport
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
    console.error("🚀 Orbiter Bridge: Stdio Transport Active");
}).catch(err => {
    console.error("❌ Failed to start bridge:", err);
});
