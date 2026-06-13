import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import type {
  StringOrMarkdown,
  ToolCallResult,
  ToolDefinition,
  ToolResultContent,
} from '@microsoft/agent-host-protocol';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult as McpCallToolResult,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';

import type { ActiveClientToolSink, ActiveClientTools } from '@wyrd-company/ahp-provider-kit';

export interface ActiveClientToolsMcpBridgeOptions {
  readonly name: string;
  readonly version?: string;
  readonly sink: ActiveClientToolSink;
}

export class ActiveClientToolsMcpBridge {
  private readonly server: HttpServer;
  private activeClientTools: ActiveClientTools | undefined;
  private turnId: string | undefined;
  private urlValue: string | undefined;

  constructor(private readonly options: ActiveClientToolsMcpBridgeOptions) {
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
  }

  get url(): string {
    if (!this.urlValue) {
      throw new Error('active-client MCP bridge has not started');
    }
    return this.urlValue;
  }

  async start(): Promise<void> {
    if (this.urlValue) {
      return;
    }
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('active-client MCP bridge did not bind to a TCP port');
    }
    this.urlValue = `http://127.0.0.1:${address.port}/mcp`;
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.activeClientTools = activeClientTools;
  }

  setCurrentTurn(turnId: string | undefined): void {
    this.turnId = turnId;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        throw error;
      }
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' }).end();
      return;
    }

    const mcpServer = this.createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      void transport.close().catch(() => undefined);
      void mcpServer.close().catch(() => undefined);
    };
    response.on('close', cleanup);
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32_603,
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    } finally {
      if (response.writableEnded || response.destroyed) {
        cleanup();
      }
    }
  }

  private createMcpServer(): Server {
    const server = new Server(
      { name: this.options.name, version: this.options.version ?? '0.1.0' },
      { capabilities: { tools: { listChanged: true } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.activeClientTools?.tools.map(toMcpTool) ?? [],
    }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const toolName = request.params.name;
      const turnId = this.turnId;
      const tool = this.activeClientTools?.tools.find(candidate => candidate.name === toolName);
      if (!turnId) {
        return mcpErrorResult(`No active AHP turn is available for tool ${toolName}`);
      }
      if (!tool) {
        return mcpErrorResult(`Active-client tool is not available: ${toolName}`);
      }

      const result = await this.options.sink.reportInvocation({
        turnId,
        toolCallId: `client-tool-${randomUUID()}`,
        toolName,
        displayName: tool.title ?? tool.name,
        invocationMessage: tool.title ?? tool.name,
        toolInput: JSON.stringify(request.params.arguments ?? {}),
      });
      return toMcpCallToolResult(result);
    });
    return server;
  }
}

function toMcpTool(tool: ToolDefinition): McpTool {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? { type: 'object' },
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    ...(tool._meta ? { _meta: tool._meta } : {}),
  };
}

function toMcpCallToolResult(result: ToolCallResult): McpCallToolResult {
  return {
    isError: !result.success,
    content: result.content?.flatMap(toMcpContent) ?? [{ type: 'text', text: stringOrMarkdown(result.pastTenseMessage) }],
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
  };
}

function toMcpContent(content: ToolResultContent): McpCallToolResult['content'] {
  if (content.type === 'text') {
    return [{ type: 'text', text: content.text }];
  }
  if (content.type === 'embeddedResource') {
    return [{
      type: 'resource',
      resource: {
        uri: 'ahp-embedded-resource:/tool-result',
        mimeType: content.contentType,
        blob: content.data,
      },
    }];
  }
  if (content.type === 'resource') {
    return [{
      type: 'resource_link',
      uri: content.uri,
      name: content.uri,
      ...(content.contentType ? { mimeType: content.contentType } : {}),
      ...(content.sizeHint ? { size: content.sizeHint } : {}),
    }];
  }
  return [{ type: 'text', text: JSON.stringify(content) }];
}

function mcpErrorResult(message: string): McpCallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function stringOrMarkdown(value: StringOrMarkdown): string {
  return typeof value === 'string' ? value : value.markdown;
}
