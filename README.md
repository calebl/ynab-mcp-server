[![MseeP.ai Security Assessment Badge](https://mseep.net/mseep-audited.png)](https://mseep.ai/app/calebl-ynab-mcp-server)

# ynab-mcp-server
[![smithery badge](https://smithery.ai/badge/@calebl/ynab-mcp-server)](https://smithery.ai/server/@calebl/ynab-mcp-server)

A Model Context Protocol (MCP) server built with mcp-framework. This MCP provides tools
for interacting with your YNAB budgets setup at https://ynab.com

<a href="https://glama.ai/mcp/servers/@calebl/ynab-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@calebl/ynab-mcp-server/badge" alt="YNAB Server MCP server" />
</a>

In order to have an AI interact with this tool, you will need to get your Personal Access Token
from YNAB: https://api.ynab.com/#personal-access-tokens. When adding this MCP server to any
client, you will need to provide your personal access token as YNAB_API_TOKEN. **This token
is never directly sent to the LLM.** It is stored privately in an environment variable for
use with the YNAB api.

## Setup
Specify env variables:
* YNAB_API_TOKEN (required)
* YNAB_BUDGET_ID (optional)

## Goal
The goal of the project is to be able to interact with my YNAB budget via an AI conversation.
There are a few primary workflows I want to enable:

## Workflows:
### First time setup
* be prompted to select your budget from your available budgets. If you try to use another
tool first, this prompt should happen asking you to set your default budget.
  * Tools needed: ListBudgets
### Manage overspent categories
### Adding new transactions
### Approving transactions
### Check total monthly spending vs total income
### Auto-distribute ready to assign funds based on category targets

## Current state
Available tools:
* ListBudgets - lists available budgets on your account
* BudgetSummary - provides a summary of categories that are underfunded and accounts that are low
* GetUnapprovedTransactions - retrieve all unapproved transactions
* CreateTransaction - creates a transaction for a specified budget and account.
  * example prompt: `Add a transaction to my Ally account for $3.98 I spent at REI today`
  * requires GetBudget to be called first so we know the account id
* ApproveTransaction - approves an existing transaction in your YNAB budget
  * requires a transaction ID to approve
  * can be used in conjunction with GetUnapprovedTransactions to approve pending transactions
  * After calling get unapproved transactions, prompt: `approve the transaction for $6.95 on the Apple Card`

Next:
* be able to approve multiple transactions with 1 call
* updateCategory tool - or updateTransaction more general tool if I can get optional parameters to work correctly with zod & mcp framework
* move off of mcp framework to use the model context protocol sdk directly?


## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Run locally with stdio (default)
npm start

# Run as HTTP server (for remote hosting)
npm run start:http

# Run as HTTP server on custom port
node dist/index.js --http --port 8080
```

## Deployment Modes

### Local Mode (Stdio)
The default mode uses stdio transport for local MCP clients like Claude Desktop:
```bash
npm start
```

### HTTP Server Mode
Run as an HTTP server with SSE (Server-Sent Events) transport for remote hosting:
```bash
# Default port 3000
npm run start:http

# Custom port
node dist/index.js --http --port 8080
```

When running in HTTP mode, the server exposes:
- `POST /sse` - MCP SSE endpoint for client connections
- `GET /health` - Health check endpoint (returns `{"status": "ok", "version": "0.1.2"}`)
- `POST /message` - Message endpoint (handled by SSE transport)

Example health check:
```bash
curl http://localhost:3000/health
```

#### Connecting MCP Clients to HTTP Server

The HTTP/SSE mode is designed for MCP clients that support remote server connections. Clients connect to the SSE endpoint:

```
POST http://localhost:3000/sse
```

> **Note:** Claude Desktop currently only supports local stdio-based MCP servers (spawned via `command`). Use the [Local Development](#local-development) configuration for Claude Desktop. HTTP mode is intended for other MCP clients, web applications, or remote hosting scenarios.

### Docker Deployment
Run the server in a Docker container with HTTP mode (runs on port 80 by default):

```bash
# Build the Docker image (builds for linux/amd64)
docker build -t ynab-mcp-server .

# Run the container on port 80
docker run -d \
  -p 80:80 \
  -e YNAB_API_TOKEN=your_token_here \
  -e YNAB_BUDGET_ID=your_budget_id \
  --name ynab-mcp \
  ynab-mcp-server

# Check health
curl http://localhost/health

# View logs
docker logs ynab-mcp

# Stop and remove
docker stop ynab-mcp
docker rm ynab-mcp
```

Map to different host port (e.g., 3000):
```bash
docker run -d \
  -p 3000:80 \
  -e YNAB_API_TOKEN=your_token_here \
  --name ynab-mcp \
  ynab-mcp-server

# Access on port 3000
curl http://localhost:3000/health
```

Custom container port:
```bash
docker run -d \
  -p 8080:8080 \
  -e YNAB_API_TOKEN=your_token_here \
  --name ynab-mcp \
  ynab-mcp-server \
  node dist/index.js --http --port 8080
```

**Multi-platform builds:**
The Dockerfile is configured for linux/amd64 by default. To build for other platforms:
```bash
# Build for multiple platforms using buildx
docker buildx build --platform linux/amd64,linux/arm64 -t ynab-mcp-server .

# Build for specific platform
docker buildx build --platform linux/arm64 -t ynab-mcp-server .
```

## Project Structure

```
ynab-mcp-server/
├── src/
│   ├── tools/        # MCP Tools
│   └── index.ts      # Server entry point
├── .cursor/
│   └── rules/        # Cursor AI rules for code generation
├── package.json
└── tsconfig.json
```

## Adding Components

The YNAB sdk describes the available api endpoints: https://github.com/ynab/ynab-sdk-js.

YNAB open api specification is here: https://api.ynab.com/papi/open_api_spec.yaml. This can
be used to prompt an AI to generate a new tool. Example prompt for Cursor Agent:

```
create a new tool based on the readme and this openapi doc: https://api.ynab.com/papi/open_api_spec.yaml

The new tool should get the details for a single budget
```

You can add more tools using the CLI:

```bash
# Add a new tool
mcp add tool my-tool

# Example tools you might create:
mcp add tool data-processor
mcp add tool api-client
mcp add tool file-handler
```

## Tool Development

Example tool structure:

```typescript
import { MCPTool } from "mcp-framework";
import { z } from "zod";

interface MyToolInput {
  message: string;
}

class MyTool extends MCPTool<MyToolInput> {
  name = "my_tool";
  description = "Describes what your tool does";

  schema = {
    message: {
      type: z.string(),
      description: "Description of this input parameter",
    },
  };

  async execute(input: MyToolInput) {
    // Your tool logic here
    return `Processed: ${input.message}`;
  }
}

export default MyTool;
```

## Publishing to npm

1. Update your package.json:
   - Ensure `name` is unique and follows npm naming conventions
   - Set appropriate `version`
   - Add `description`, `author`, `license`, etc.
   - Check `bin` points to the correct entry file

2. Build and test locally:
   ```bash
   npm run build
   npm link
   ynab-mcp-server  # Test your CLI locally
   ```

3. Login to npm (create account if necessary):
   ```bash
   npm login
   ```

4. Publish your package:
   ```bash
   npm publish
   ```

After publishing, users can add it to their claude desktop client (read below) or run it with npx


## Using with Claude Desktop

### Installing via Smithery

To install YNAB Budget Assistant for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@calebl/ynab-mcp-server):

```bash
npx -y @smithery/cli install @calebl/ynab-mcp-server --client claude
```

### Local Development

To set up the MCP server locally with Claude Desktop:

**1. Clone and build the project:**
```bash
git clone https://github.com/calebl/ynab-mcp-server.git
cd ynab-mcp-server
npm install
npm run build
```

**2. Get your YNAB Personal Access Token:**
- Go to https://app.ynab.com/settings/developer
- Create a new Personal Access Token
- Copy the token (you'll only see it once)

**3. Add the server to Claude Desktop:**

Open your Claude Desktop config file:
- **MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

Add the following configuration (replace the placeholders with your values):

```json
{
  "mcpServers": {
    "ynab-mcp-server": {
      "command": "node",
      "args": ["/absolute/path/to/ynab-mcp-server/dist/index.js"],
      "env": {
        "YNAB_API_TOKEN": "your_ynab_personal_access_token"
      }
    }
  }
}
```

**4. Restart Claude Desktop** to load the new MCP server.

**5. Verify the connection** by asking Claude: "List my YNAB budgets"

> **Tip:** You can optionally add `"YNAB_BUDGET_ID": "your_default_budget_id"` to the `env` object to set a default budget, so you don't have to specify it with each request.

### After Publishing (via npx)

Add this configuration to your Claude Desktop config file:

- **MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ynab-mcp-server": {
      "command": "npx",
      "args": ["-y", "ynab-mcp-server"],
      "env": {
        "YNAB_API_TOKEN": "your_ynab_personal_access_token"
      }
    }
  }
}
```

### Other MCP Clients
Check https://modelcontextprotocol.io/clients for other available clients.

## Building and Testing

1. Make changes to your tools
2. Run `npm run build` to compile
3. The server will automatically load your tools on startup

## Learn More

- [MCP Framework Github](https://github.com/QuantGeekDev/mcp-framework)
- [MCP Framework Docs](https://mcp-framework.com)
