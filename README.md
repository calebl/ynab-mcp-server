# ynab-mcp-server

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
* YNAP_API_TOKEN (required)
* KNOWLEDGE_DIR (optional) - directory where knowledge file should be stored. Defaults to `data` directory where the server is running.
* KNOWLEDGE_FILE (optional) - name of knowledge filed. Defaults to `server-knowledge.json`

## Goal
The goal of the project is to be able to interact with my YNAB budget via an AI conversation.
There are a few primary workflows I want to enable:

## Workflows:
### First time setup
* be prompted to select your budget from your available budgets. If you try to use another
tool first, this prompt should happen asking you to set your default budget.
  * Tools needed: ListBudgets, SetBudget
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

Next:
* move to using budget by month call instead of getting categories from the entire budget: https://api.ynab.com/v1#/Months/getBudgetMonth


## Quick Start

```bash
# Install dependencies
npm install

# Build the project
npm run build

```

## Project Structure

```
ynab-mcp-server/
├── src/
│   ├── tools/        # MCP Tools
│   └── index.ts      # Server entry point
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

### Local Development

Add this configuration to your Claude Desktop config file:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ynab-mcp-server": {
      "command": "node",
      "args":["/absolute/path/to/ynab-mcp-server/dist/index.js"]
    }
  }
}
```

### After Publishing

Add this configuration to your Claude Desktop config file:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ynab-mcp-server": {
      "command": "npx",
      "args": ["ynab-mcp-server"]
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