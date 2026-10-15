import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

// stdio entry for local MCP clients (Claude Desktop, Claude Code). Nothing may write to stdout
// except the protocol itself. STEWARD_USER picks whose graph (default: the demo user).
const server = createMcpServer(process.env.STEWARD_USER ?? "demo");
await server.connect(new StdioServerTransport());
