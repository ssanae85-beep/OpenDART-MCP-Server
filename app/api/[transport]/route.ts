import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "@/lib/tools";

const handler = createMcpHandler(
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

export { handler as GET, handler as POST, handler as DELETE };
