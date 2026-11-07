#!/usr/bin/env node
// stdio entry point: `dry-powder-mcp` (configured from the environment, see README.md).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.mjs";

const server = createServer();
await server.connect(new StdioServerTransport());
console.error("dry-powder-mcp ready on stdio");
