import { getMcpServerUrl } from "../mcp-url";
import { Logo } from "./assets/logo";

const MCP_SERVER_URL = getMcpServerUrl();

export default {
  name: "Zed",
  id: "zed-mcp",
  category: "ai-automation",
  active: true,
  logo: Logo,
  short_description:
    "Connect Zed to your Midday financial data via MCP with OAuth.",
  description: `Connect Zed to your Midday account using the Model Context Protocol (MCP). No API key needed — authentication is handled automatically via OAuth.

**What you can do:**
- Query transactions, invoices, and reports from Zed
- Get financial insights while you code
- Track time and manage invoices without switching apps

**Setup steps:**

**Via Agent Panel:**
1. Open the Agent Panel settings and click **Add Custom Server**
2. Enter the URL: \`${MCP_SERVER_URL}\`
3. When prompted, sign in to Midday in your browser

**Via settings.json:**
Add to your Zed settings:
\`\`\`json
{
  "context_servers": {
    "midday": {
      "url": "${MCP_SERVER_URL}"
    }
  }
}
\`\`\`

**Requirements:** Zed editor installed.`,
  images: [],
};
