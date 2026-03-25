export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>OpenDART MCP Server</h1>
      <p>This is an MCP server for the OpenDART API (Korean corporate disclosure data).</p>
      <p>Connect via Claude: Settings &gt; Connectors &gt; Add custom connector</p>
      <p>MCP Endpoint: <code>/api/mcp</code></p>
    </main>
  );
}
