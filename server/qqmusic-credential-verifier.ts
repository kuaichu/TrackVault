const QQ_LOGIN_STATUS_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

export type QqCredentialVerificationErrorType =
  | "credential_rejected"
  | "rate_limited"
  | "temporary_failure"
  | "protocol_response_invalid";

export class QqCredentialVerificationError extends Error {
  constructor(public readonly errorType: QqCredentialVerificationErrorType) {
    super(errorType);
    this.name = "QqCredentialVerificationError";
  }
}

export type QqLoginStatusRequest = {
  comm: {
    ct: number;
    cv: number;
    format: "json";
    uin: string;
  };
  req_0: {
    module: "music.UserInfo.userInfoServer";
    method: "GetLoginUserInfo";
    param: Record<string, never>;
  };
};

export type QqLoginStatusTransport = (
  request: QqLoginStatusRequest,
  cookie: Record<string, string>
) => Promise<unknown>;

function serializeCookie(cookie: Record<string, string>) {
  return Object.entries(cookie).map(([key, value]) => `${key}=${value}`).join("; ");
}

export const fetchQqLoginStatus: QqLoginStatusTransport = async (request, cookie) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(QQ_LOGIN_STATUS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: serializeCookie(cookie)
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });
  } catch {
    throw new QqCredentialVerificationError("temporary_failure");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new QqCredentialVerificationError("rate_limited");
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new QqCredentialVerificationError("temporary_failure");
    }
    throw new QqCredentialVerificationError("protocol_response_invalid");
  }
  try {
    return await response.json();
  } catch {
    throw new QqCredentialVerificationError("protocol_response_invalid");
  }
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeUin(value: unknown) {
  const normalized = typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(normalized) ? normalized : null;
}

function classifyProviderCode(code: number): QqCredentialVerificationErrorType {
  if (code === 1000 || code === 104400 || code === 104401) return "credential_rejected";
  if (code === 2001 || code === 429) return "rate_limited";
  return "protocol_response_invalid";
}

export function createQqCredentialVerifier(transport: QqLoginStatusTransport) {
  return async function verifyCredential(cookie: Record<string, string>) {
    const submittedUin = normalizeUin(cookie.uin);
    if (!submittedUin) {
      throw new QqCredentialVerificationError("credential_rejected");
    }

    const request: QqLoginStatusRequest = {
      comm: { ct: 24, cv: 0, format: "json", uin: submittedUin },
      req_0: {
        module: "music.UserInfo.userInfoServer",
        method: "GetLoginUserInfo",
        param: {}
      }
    };

    let payload: unknown;
    try {
      payload = await transport(request, cookie);
    } catch (error) {
      if (error instanceof QqCredentialVerificationError) throw error;
      throw new QqCredentialVerificationError("temporary_failure");
    }

    const root = asRecord(payload);
    if (typeof root?.code !== "number") {
      throw new QqCredentialVerificationError("protocol_response_invalid");
    }
    if (root.code !== 0) {
      throw new QqCredentialVerificationError(classifyProviderCode(root.code));
    }

    const result = asRecord(root.req_0);
    if (typeof result?.code !== "number") {
      throw new QqCredentialVerificationError("protocol_response_invalid");
    }
    if (result.code !== 0) {
      throw new QqCredentialVerificationError(classifyProviderCode(result.code));
    }

    const data = asRecord(result.data);
    const userInfo = asRecord(data?.user_info);
    if (userInfo && Object.prototype.hasOwnProperty.call(userInfo, "uin")) {
      const responseUin = normalizeUin(userInfo.uin);
      if (!responseUin) {
        throw new QqCredentialVerificationError("protocol_response_invalid");
      }
      if (responseUin !== submittedUin) {
        throw new QqCredentialVerificationError("credential_rejected");
      }
    }
    return { uin: submittedUin };
  };
}

export const verifyQqCredential = createQqCredentialVerifier(fetchQqLoginStatus);

export function getQqCredentialVerificationMessage(errorType: QqCredentialVerificationErrorType) {
  switch (errorType) {
    case "credential_rejected": return "QQ 音乐凭证已被拒绝。请重试或清除凭证。";
    case "rate_limited": return "QQ 音乐凭证验证请求过于频繁。请稍后重试。";
    case "temporary_failure": return "QQ 音乐凭证验证暂时失败。请稍后重试或清除凭证。";
    case "protocol_response_invalid": return "QQ 音乐凭证验证响应异常。请稍后重试或清除凭证。";
  }
}
