# AHP Claude Agent SDK Provider

TypeScript provider adapter that lets an AHP server run Claude Agent SDK sessions.

Package target: `@wyrd-company/ahp-claude-agent-sdk`.

This package is intentionally separate from `@wyrd-company/ahp-server` so consumers explicitly opt into the Claude runtime and MCP dependencies and wire the provider into their server process.

## Behavior

- Creates one Claude Agent SDK query per AHP session.
- Uses the AHP session working directory as the Claude SDK `cwd`.
- Sends AHP user turns through the SDK streaming input queue.
- Maps streamed Claude assistant deltas to AHP markdown response parts and deltas.
- Maps Claude SDK success results to `session/turnComplete`.
- Interrupts active turns through the Claude SDK query.
- Closes the Claude query and MCP bridge when the AHP session is disposed.

## Active-Client Tools

The provider maps AHP active-client tools to a per-session local Streamable HTTP MCP server.

- Tools present at session creation are exposed through the `activeClientTools` MCP server.
- `session/activeClientToolsChanged` updates the MCP server tool list for the session.
- Claude invokes active-client tools through MCP `tools/call`; the adapter routes that call through `ActiveClientToolSink.reportInvocation(...)`.
- AHP owns session URI, turn id, tool call id, tool name, and active-client identity. Tool input is passed through as display/input data only.
- Only the active client that owns the tool call can complete it through normal AHP `session/toolCallComplete`.

## Session Resume

The provider implements `ResumableAgentProvider`. When `ahp-server` reloads a
persisted AHP session, the adapter recreates the Claude Agent SDK session wrapper
from the stored AHP working directory, model, config, and active-client tools.
After the SDK emits a `session_id`, the adapter stores it through the
provider-owned resume-state hook and passes it back as Claude SDK
`options.resume` after a server restart.

## Usage

```ts
import { AhpServer } from '@wyrd-company/ahp-server';
import { createClaudeAgentSdkProvider } from '@wyrd-company/ahp-claude-agent-sdk';

const server = new AhpServer({
  providers: [
    createClaudeAgentSdkProvider({
      defaultModel: process.env.CLAUDE_AGENT_SDK_MODEL,
      pathToClaudeCodeExecutable: process.env.CLAUDE_AGENT_SDK_EXECUTABLE,
      permissionMode: 'dontAsk',
    }),
  ],
});
```

## Development

```bash
npm install
npm run verify
```

Live validation requires Claude Agent SDK credentials/runtime access:

```bash
CLAUDE_AGENT_SDK_ENABLED=1 npm run test:live
```

Optional environment variables:

- `CLAUDE_AGENT_SDK_MODEL`
- `CLAUDE_AGENT_SDK_EXECUTABLE`
- `CLAUDE_AGENT_SDK_LIVE_TURN_PROMPT`
