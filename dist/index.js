#!/usr/bin/env node
import { startHttpServer } from "./httpServer.js";
import { resolveAppConfig } from "./config.js";
import { startStdioServer } from "./stdioServer.js";
// Start the server
async function main() {
    const config = resolveAppConfig(process.argv.slice(2), process.env);
    if (config.runtime.transport === "http") {
        const server = await startHttpServer(config.runtime);
        console.error(`YNAB MCP server running on ${server.url}`);
        return;
    }
    await startStdioServer();
}
main().catch(console.error);
