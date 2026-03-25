# OpenDART MCP Server

한국 금융감독원 [OpenDART API](https://opendart.fss.or.kr/)를 Claude에서 바로 사용할 수 있는 MCP(Model Context Protocol) 서버입니다.

Vercel에 배포하면 ngrok 없이 Claude Custom Connector로 바로 연결할 수 있습니다.

## Features

- **31개 도구**: 회사 검색, 재무제표, 공시 검색, 주주 정보, 주요 사항 보고 등
- **워크플로우 도구**: 회사 이름 검색, 재무 요약, 기업 비교, 최근 공시 요약
- **사용자별 API 키**: `set_api_key`로 각자의 API 키를 사용 — 서버 공유 가능
- **마크다운 출력**: Claude에서 깔끔하게 렌더링되는 테이블 형태
- **한/영 에러 메시지**: 에러 발생 시 한국어와 영어로 안내
- **재시도 로직**: API 오류 시 자동 재시도
- **Corp Code 캐싱**: 9만+ 기업 목록을 인메모리 캐싱 (24시간 TTL)

## Quick Start

### 1. OpenDART API 키 발급

[OpenDART](https://opendart.fss.or.kr/)에서 회원가입 후 API 인증키를 발급받으세요.

### 2. Vercel에 배포

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/opendart-mcp)

또는 CLI로 배포:

```bash
git clone <this-repo>
cd opendart-mcp
npm install
vercel link
vercel deploy
```

> **참고**: `OPENDART_API_KEY` 환경변수는 선택사항입니다. 설정하지 않으면 사용자가 `set_api_key`로 각자의 키를 사용합니다.

### 3. Claude에 연결

1. [claude.ai](https://claude.ai) 접속
2. Settings > Connectors > Add custom connector
3. URL 입력: `https://your-project.vercel.app/api/mcp?opendart_key=YOUR_API_KEY`
4. 연결 완료! 별도 설정 없이 바로 사용 가능

## API Key 사용 방법

### 방법 A: 서버에 환경변수 설정 (나만 사용)

Vercel 대시보드에서 `OPENDART_API_KEY` 환경변수를 설정하면 모든 도구가 자동으로 사용합니다.

### 방법 B: URL에 API 키 포함 (추천, 공유 서버)

커넥터 URL에 API 키를 포함하면 대화에서 별도 설정이 필요 없습니다:

```
https://your-project.vercel.app/api/mcp?opendart_key=YOUR_API_KEY
```

각 사용자가 자신의 키를 URL에 넣어 커넥터를 등록하면, 서버 운영자의 API 한도를 보호합니다.

### 방법 C: 대화 중 설정

대화 중 `set_api_key` 도구를 호출하여 설정할 수도 있습니다.

**우선순위**: 도구별 `api_key` 파라미터 > URL 키 / 세션 키 > 서버 환경변수

## Tools

### Config Tools

| Tool | 설명 |
|------|------|
| `set_api_key` | OpenDART API 키를 세션에 설정 |
| `get_api_key_status` | API 키 설정 여부 확인 |

### Workflow Tools (추천)

| Tool | 설명 |
|------|------|
| `opendart_search_company` | 한글/영문 이름 또는 종목코드로 회사 검색 |
| `opendart_financial_summary` | 회사 개황 + 주요 재무정보 + 재무지표 통합 요약 |
| `opendart_compare_companies` | 2~5개 기업 재무지표 비교 |
| `opendart_recent_disclosures` | 최근 N일간 공시 요약 |

### Core Tools

| Category | Tools | 설명 |
|----------|-------|------|
| Company | 2 | 기업 개황, 공시 검색 |
| Financial | 7 | 재무제표, 재무지표, 배당, XBRL |
| Periodic Reports | 8 | 주주, 임원, 직원, 보수, 감사 |
| Shareholding | 2 | 대량보유, 임원 소유 보고 |
| Major Events | 5 | 유상증자, 감자, 합병 등 |

## Usage Examples

Claude에서 다음과 같이 사용하세요:

- "삼성전자의 최근 재무 현황을 알려줘"
- "카카오와 네이버의 2024년 재무지표를 비교해줘"
- "SK하이닉스의 최근 30일간 공시를 보여줘"
- "LG에너지솔루션의 최대주주 현황을 알려줘"

## Development

```bash
npm install
# .env.local에 OPENDART_API_KEY=your_key 추가 (선택)
npm run dev
# http://localhost:3000/api/mcp 에서 MCP 서버 실행
```

## License

MIT
