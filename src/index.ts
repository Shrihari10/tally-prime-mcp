#!/usr/bin/env node
// Tally Prime MCP server — entry point.
// Speaks the Model Context Protocol over stdio, exposing Tally's XML/HTTP
// gateway as a set of typed tools that Claude Cowork (and any other MCP
// client) can call directly.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./jsonschema.js";

import { TallyClient } from "./tally/client.js";
import { loadConfig } from "./tally/config.js";
import { masterTools } from "./tools/masters.js";
import { voucherTools } from "./tools/vouchers.js";
import { reportTools } from "./tools/reports.js";
import type { Tool } from "./tools/types.js";

const allTools: Tool[] = [...masterTools, ...voucherTools, ...reportTools];
const toolsByName = new Map(allTools.map((t) => [t.name, t]));

async function main() {
  const config = loadConfig();
  const client = new TallyClient(config);

  const server = new Server(
    {
      name: "tally-prime-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolsByName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await tool.handler(req.params.arguments ?? {}, client);
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: ${err?.message ?? String(err)}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr only — stdout is reserved for MCP framing.
  process.stderr.write(
    `[tally-prime-mcp] connected, target=${config.url}` +
      (config.defaultCompany ? `, company=${config.defaultCompany}` : "") +
      `, tools=${allTools.length}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[tally-prime-mcp] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
