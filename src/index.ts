import { MCPServer } from "mcp-framework";
import { z } from "zod";

// Define session configuration schema
export const configSchema = z.object({
  ynabApiToken: z.string().describe("The YNAB API token to use"),
  ynabBudgetId: z.string().optional().describe("(Optional)The YNAB budget ID to use"),
});

export default function createServer({config} : {config: z.infer<typeof configSchema>}) {
  const server = new MCPServer({
    transport: {
      type: "http-stream",
      options: {
        responseMode: "stream"
      }
    }
  })

  return server;
}

const server = new MCPServer();

server.start();

// Handle shutdown
process.on("SIGINT", async () => {
  await server.stop();
});
