const STATUS_MESSAGES: Record<string, { ko: string; en: string }> = {
  "000": { ko: "정상", en: "Success" },
  "010": { ko: "등록되지 않은 키입니다", en: "Unregistered API key" },
  "011": { ko: "사용할 수 없는 키입니다", en: "Disabled API key" },
  "013": { ko: "조회된 데이터가 없습니다", en: "No data found" },
  // document.xml only. Two different causes share this code: an archive that
  // hasn't been generated yet (filed hours ago — retry later) and one that will
  // never exist (notice-type filings such as 효력발생안내). Verified against the
  // live API; the message says both so the caller can tell them apart by age.
  "014": {
    ko: "파일이 존재하지 않습니다. 접수 당일 건이면 원문이 아직 생성되지 않은 것이니 나중에 다시 시도하고, 며칠 지난 건이면 원문이 없는 공시입니다(효력발생안내 등 안내성 공시)",
    en: "File does not exist. If the filing is from today the archive may not be generated yet — retry later; if it is days old, this filing has no document (notice-type disclosures).",
  },
  "020": {
    ko: "요청 제한을 초과하였습니다",
    en: "Request limit exceeded. Please wait or use your own API key.",
  },
  "100": { ko: "필드의 부적절한 값입니다", en: "Invalid field value" },
  "800": {
    ko: "일일 요청 한도를 초과하였습니다",
    en: "Daily request limit exceeded. Try again tomorrow or use your own API key.",
  },
  "900": {
    ko: "정의되지 않은 오류가 발생하였습니다",
    en: "Undefined error occurred",
  },
};

export class OpenDartError extends Error {
  constructor(
    public statusCode: string,
    public endpoint: string,
  ) {
    const msgs = STATUS_MESSAGES[statusCode] || STATUS_MESSAGES["900"];
    super(`[OpenDART ${statusCode}] ${msgs.en} / ${msgs.ko} (endpoint: ${endpoint})`);
    this.name = "OpenDartError";
  }
}

export class OpenDartNetworkError extends Error {
  constructor(
    public type: "timeout" | "network" | "http",
    public endpoint: string,
    public attempt: number,
    public maxAttempts: number,
    public httpStatus?: number,
  ) {
    const messages: Record<string, { ko: string; en: string }> = {
      timeout: {
        ko: `요청 시간 초과 (${attempt}/${maxAttempts}회 시도). OpenDART 서버 응답이 느립니다. 잠시 후 다시 시도해주세요.`,
        en: `Request timeout (attempt ${attempt}/${maxAttempts}). OpenDART server is slow. Please try again shortly.`,
      },
      network: {
        ko: `네트워크 연결 실패 (${attempt}/${maxAttempts}회 시도). OpenDART 서버에 연결할 수 없습니다.`,
        en: `Network connection failed (attempt ${attempt}/${maxAttempts}). Cannot reach OpenDART server.`,
      },
      http: {
        ko: `HTTP ${httpStatus || ""} 서버 오류 (${attempt}/${maxAttempts}회 시도).`,
        en: `HTTP ${httpStatus || ""} server error (attempt ${attempt}/${maxAttempts}).`,
      },
    };
    const msg = messages[type];
    super(`[OpenDART] ${msg.en} / ${msg.ko} (endpoint: ${endpoint})`);
    this.name = "OpenDartNetworkError";
  }
}

export function isNoData(status: string): boolean {
  return status === "013";
}

export function checkResponse(data: { status: string; message: string }, endpoint: string): void {
  if (data.status === "000" || data.status === "013") return;
  throw new OpenDartError(data.status, endpoint);
}

export function formatApiError(error: unknown): string {
  if (error instanceof OpenDartNetworkError) {
    if (error.type === "timeout") {
      return `${error.message}\n\n💡 OpenDART API 서버가 일시적으로 느린 상태입니다. 잠시 후 다시 시도해주세요.`;
    }
    if (error.type === "network") {
      return `${error.message}\n\n💡 인터넷 연결 또는 OpenDART 서버 상태를 확인해주세요. (https://opendart.fss.or.kr)`;
    }
    return error.message;
  }
  if (error instanceof OpenDartError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `[OpenDART Error] ${error.message}`;
  }
  return "[OpenDART Error] An unexpected error occurred.";
}
