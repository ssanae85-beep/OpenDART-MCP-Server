const STATUS_MESSAGES: Record<string, { ko: string; en: string }> = {
  "000": { ko: "정상", en: "Success" },
  "010": { ko: "등록되지 않은 키입니다", en: "Unregistered API key" },
  "011": { ko: "사용할 수 없는 키입니다", en: "Disabled API key" },
  "013": { ko: "조회된 데이터가 없습니다", en: "No data found" },
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

export function isNoData(status: string): boolean {
  return status === "013";
}

export function checkResponse(data: { status: string; message: string }, endpoint: string): void {
  if (data.status === "000" || data.status === "013") return;
  throw new OpenDartError(data.status, endpoint);
}

export function formatApiError(error: unknown): string {
  if (error instanceof OpenDartError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `[OpenDART Error] ${error.message}`;
  }
  return "[OpenDART Error] An unexpected error occurred.";
}
