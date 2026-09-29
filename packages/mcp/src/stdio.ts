#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRosterMcpServer, readRosterClientOptions } from "./index.js";

const credentials = readRosterClientOptions(process.env);
const server = createRosterMcpServer({ ...credentials, env: process.env });
await server.connect(new StdioServerTransport());
