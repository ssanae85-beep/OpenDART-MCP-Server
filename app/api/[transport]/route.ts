import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/lib/tools";
import { setSessionApiKey } from "@/lib/opendart/client";

const mcpHandler = createMcpHandler(
  (server) => {
    registerAllTools(server);
  },
  {
    capabilities: {},
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  }
);

async function handler(req: Request) {
  const url = new URL(req.url);
  const apiKey = url.searchParams.get("opendart_key");
  if (apiKey) {
    setSessionApiKey(apiKey);
  }
  return mcpHandler(req);
}

export { handler as GET, handler as POST, handler as DELETE };
