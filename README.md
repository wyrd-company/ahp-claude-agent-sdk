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

## Releasing

[Intentional](https://github.com/wyrd-company/intentional) is the version and
release-intent authority for this repository. `.intentional/config.yml` defines
the single `ahp-claude-agent-sdk` release unit, `package.json` is a projection of that state,
and Git tags are the released-version record. Do not hand-edit the version in
`package.json`.

Continuous integration runs `intentional check` on every pull request and on
`main`. It validates only; it never releases.

### Record a change

Author an intent alongside the implementation it describes:

```bash
intentional add --release-unit ahp-claude-agent-sdk:minor --message "Add a user-visible capability."
```

Use `major`, `minor`, or `patch` for the compatibility impact of the change.
While the package is below `1.0.0`, the configured `compatibility` mapping
shifts each bump down one position: a `major` intent moves the minor number and
both `minor` and `patch` intents move the patch number. Commit the generated
file in `.intentional/intents/` with the code change.

### Cut a release

Releasing is a deliberate, human-authorized action. Nothing below happens
automatically.

```bash
intentional status
intentional check
intentional plan > release-plan.json
intentional apply --dry-run
intentional apply

git add -A
git commit -m "chore: release"
```

`apply` writes the new version into `package.json`, updates `CHANGELOG.md`, and
consumes the included intents.

`main` accepts changes only through a pull request, so open one for the release
commit and merge it. Then tag the merged commit on `main`:

```bash
git switch main && git pull
intentional tag --plan release-plan.json
```

`tag` creates the annotated release record using the plain `N.N.N` tag name that
the CD workflow expects. Pushing that tag starts publication and is the point of
no return:

```bash
git push origin <version>
```

`.github/workflows/cd.yml` reacts to the tag: it verifies the tag matches
`package.json`, builds, publishes to npmjs and GitHub Packages, and creates the
GitHub release. Delete `release-plan.json` once the release is tagged; it is
working material, not repository state.
