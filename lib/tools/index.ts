import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCompanyTools } from "./company";
import { registerFinancialTools } from "./financial";
import { registerDisclosureTools } from "./disclosure";
import { registerShareholdingTools } from "./shareholding";
import { registerMajorEventTools } from "./major-events";
import { registerWorkflowTools } from "./workflows";

export function registerAllTools(server: McpServer) {
  registerWorkflowTools(server);      // Workflow tools first (most useful)
  registerCompanyTools(server);        // Company search & info
  registerFinancialTools(server);      // Financial statements & indicators
  registerDisclosureTools(server);     // Periodic report details
  registerShareholdingTools(server);   // Shareholding disclosures
  registerMajorEventTools(server);     // Major corporate events
}
