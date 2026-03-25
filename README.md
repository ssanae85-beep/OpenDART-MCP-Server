# OpenDART MCP Server

한국 금융감독원 [OpenDART API](https://opendart.fss.or.kr/)를 Claude에서 바로 사용할 수 있는 MCP(Model Context Protocol) 서버입니다.

Vercel에 배포하면 ngrok 없이 Claude Custom Connector로 바로 연결할 수 있습니다.

> [RealYoungk/opendart-mcp](https://github.com/RealYoungk/opendart-mcp)를 기반으로 TypeScript + Next.js로 재구현하고, Vercel 배포 및 기능을 확장한 버전입니다.

## Features

- **~83개 도구**: 원본 Python 버전과 동일한 수준의 API 커버리지
- **Vercel 배포**: ngrok/터널링 없이 Custom Connector로 바로 연결
- **URL 기반 API 키**: 커넥터 URL에 키를 포함하여 설정 없이 즉시 사용
- **마크다운 출력**: Claude에서 깔끔하게 렌더링되는 테이블 형태
- **한/영 에러 메시지**: 구체적인 오류 안내 (타임아웃, 네트워크 등 분류)
- **자동 재시도**: API 오류 시 최대 3회 재시도
- **Corp Code 캐싱**: 9만+ 기업 목록을 인메모리 캐싱 (24시간 TTL)
- **인코딩 자동 감지**: EUC-KR/CP949/UTF-8 XML 자동 처리

## Quick Start

### 1. OpenDART API 키 발급

[OpenDART](https://opendart.fss.or.kr/)에서 회원가입 후 API 인증키를 발급받으세요.

### 2. Vercel에 배포

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/procpalee/OpenDART-MCP-Server)

또는 CLI로 배포:

```bash
git clone https://github.com/procpalee/OpenDART-MCP-Server.git
cd OpenDART-MCP-Server
npm install
vercel link
vercel deploy
```

### 3. Claude에 연결

1. [claude.ai](https://claude.ai) 접속
2. Settings > Connectors > Add custom connector
3. URL 입력: `https://your-project.vercel.app/api/mcp?opendart_key=YOUR_API_KEY`
4. 연결 완료! 별도 설정 없이 바로 사용 가능

## API Key 사용 방법

### 방법 A: URL에 API 키 포함 (추천)

커넥터 URL에 API 키를 포함하면 대화에서 별도 설정이 필요 없습니다:

```
https://your-project.vercel.app/api/mcp?opendart_key=YOUR_API_KEY
```

다른 사용자에게 서버를 공유할 때, 각 사용자가 자신의 키를 URL에 넣어 커넥터를 등록하면 서버 운영자의 API 한도를 보호할 수 있습니다.

### 방법 B: 서버에 환경변수 설정 (나만 사용)

Vercel 대시보드에서 `OPENDART_API_KEY` 환경변수를 설정하면 모든 도구가 자동으로 사용합니다.

### 방법 C: 대화 중 설정

대화 중 `set_api_key` 도구를 호출하여 설정할 수도 있습니다.

**우선순위**: 도구별 `api_key` 파라미터 > URL 키 / 세션 키 > 서버 환경변수

## Tools

### Config (2개)

| Tool | 설명 |
|------|------|
| `set_api_key` | OpenDART API 키를 세션에 설정 |
| `get_api_key_status` | API 키 설정 여부 확인 |

### 회사 검색 & 정보 (3개)

| Tool | 설명 |
|------|------|
| `opendart_search_company` | 한글/영문 이름 또는 종목코드로 회사 검색 → corp_code 획득 |
| `opendart_get_company_info` | 기업 개황 (대표이사, 주소, 업종 등) |
| `opendart_search_disclosure` | 공시 검색 (기간, 유형, 페이지네이션) |

### 재무 정보 (7개)

| Tool | 설명 |
|------|------|
| `opendart_single_financial_accounts` | 단일회사 주요계정 (매출, 영업이익, 자산 등) |
| `opendart_multi_financial_accounts` | 다중회사 주요계정 비교 (최대 100개) |
| `opendart_full_financial_statement` | 전체 재무제표 (BS, IS, CF 전 항목) |
| `opendart_single_financial_index` | 단일회사 재무지표 (수익성, 안정성, 성장성) |
| `opendart_multi_financial_index` | 다중회사 재무지표 비교 |
| `opendart_xbrl_taxonomy` | XBRL 표준 계정과목 분류 |
| `opendart_dividend_info` | 배당 관련 정보 |

### 정기보고서 세부 항목 (24개)

| Category | Tools | 설명 |
|----------|-------|------|
| 주주 | 3 | 최대주주, 최대주주 변동, 소액주주 현황 |
| 임원/직원 | 3 | 임원 현황, 직원 현황, 사외이사 |
| 보수 | 5 | 개인별, 전체, 상위5인, 미등기임원, 승인총액 |
| 주식 | 3 | 발행주식총수, 증자/감자 현황, 자기주식 |
| 감사 | 3 | 감사의견, 회계감사 계약, 비감사 서비스 |
| 채무증권 | 5 | 발행실적, 기업어음, 단기사채, 회사채, 신종자본증권, 조건부자본증권 |
| 투자/자금 | 3 | 타법인 출자, 공모자금, 사모자금 사용내역 |

### 주주 보유 보고 (2개)

| Tool | 설명 |
|------|------|
| `opendart_major_stockholding` | 대량보유 상황보고 (5% 이상) |
| `opendart_executive_stockholding` | 임원/주요주주 보유 보고 |

### 주요사항보고서 (36개)

| Category | Tools | 설명 |
|----------|-------|------|
| 자본 변동 | 4 | 유상증자, 무상증자, 유무상증자, 감자 |
| 조직 변경 | 3 | 합병, 분할, 분할합병 |
| 영업/자산 양수도 | 7 | 영업양수, 영업양도, 유형자산 양수/양도, 타법인 주식 취득/처분, 자산양수도(풋백옵션) |
| 자기주식 | 5 | 취득, 처분, 신탁 체결, 신탁 해지, 주식교환/이전 |
| 사채 | 7 | 전환사채, 신주인수권부사채, 교환사채, 조건부자본증권, 주식관련사채 양수/양도, 주식배당 |
| 해외상장 | 4 | 상장/폐지 결정, 상장/폐지 현황 |
| 법률/경영 | 6 | 채권은행관리 개시/중단, 채무불이행, 소송, 영업정지, 회생절차, 해산 |

### 증권신고서 (6개)

| Tool | 설명 |
|------|------|
| `opendart_equity_securities_reg` | 지분증권 신고서 |
| `opendart_debt_securities_reg` | 채무증권 신고서 |
| `opendart_depositary_receipts_reg` | 예탁증권 신고서 |
| `opendart_merger_reg` | 합병 신고서 |
| `opendart_stock_exchange_reg` | 주식교환 신고서 |
| `opendart_division_reg` | 분할 신고서 |

## Usage Examples

Claude에서 다음과 같이 사용하세요:

- "삼성전자의 2024년 재무제표를 보여줘"
- "SK하이닉스의 최대주주 현황을 알려줘"
- "카카오의 최근 공시를 검색해줘"
- "현대자동차의 임원 보수 현황을 보여줘"
- "LG에너지솔루션에 전환사채 발행 결정이 있었는지 확인해줘"

## Development

```bash
npm install
# .env.local에 OPENDART_API_KEY=your_key 추가 (선택)
npm run dev
# http://localhost:3000/api/mcp 에서 MCP 서버 실행
```

## Tech Stack

- **Runtime**: Next.js 16 + TypeScript
- **MCP**: mcp-handler + @modelcontextprotocol/sdk
- **Deploy**: Vercel (Streamable HTTP, Seoul region 권장)
- **ZIP**: fflate (corp code XML 압축 해제)

## Credits

- [RealYoungk/opendart-mcp](https://github.com/RealYoungk/opendart-mcp) — 원본 Python MCP 서버
- [OpenDART API](https://opendart.fss.or.kr/) — 금융감독원 전자공시시스템

## License

MIT
