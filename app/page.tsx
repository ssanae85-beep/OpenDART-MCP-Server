export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui", maxWidth: "720px" }}>
      <h1>OpenDART MCP Server</h1>
      <p>
        한국 금융감독원{" "}
        <a href="https://opendart.fss.or.kr/">OpenDART API</a>를 Claude에서 바로
        사용할 수 있는 MCP 서버입니다.
      </p>

      <h2>연결 방법</h2>
      <ol>
        <li>
          <a href="https://claude.ai">claude.ai</a> &gt; Settings &gt;
          Connectors &gt; Add custom connector
        </li>
        <li>
          URL 입력: <code>https://your-project.vercel.app/api/mcp</code>
        </li>
      </ol>

      <h2>API 키 설정</h2>
      <p>
        <a href="https://opendart.fss.or.kr/">opendart.fss.or.kr</a>에서 무료로
        API 키를 발급받은 후, Claude에서 대화 시작 시 다음과 같이 입력하세요:
      </p>
      <blockquote style={{ background: "#f5f5f5", padding: "1rem", borderLeft: "4px solid #333" }}>
        &quot;OpenDART API 키를 설정해줘: <code>YOUR_API_KEY</code>&quot;
      </blockquote>
      <p>
        Claude가 <code>set_api_key</code> 도구를 호출하여 세션 동안 자동으로
        사용합니다. 매번 키를 입력할 필요 없습니다.
      </p>

      <h2>MCP Endpoint</h2>
      <p>
        <code>/api/mcp</code>
      </p>
    </main>
  );
}
