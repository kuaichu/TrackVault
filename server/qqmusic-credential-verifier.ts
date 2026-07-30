const QQ_LOGIN_STATUS_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";

export type QqCredentialVerificationErrorType =
  | "credential_rejected"
  | "network_failure"
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
  let response: Response;
  try {
    response = await fetch(QQ_LOGIN_STATUS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: serializeCookie(cookie)
      },
      body: JSON.stringify(request)
    });
  } catch {
    throw new QqCredentialVerificationError("network_failure");
  }

  if (!response.ok) {
    throw new QqCredentialVerificationError("network_failure");
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
      throw new QqCredentialVerificationError("network_failure");
    }

    const root = asRecord(payload);
    const result = asRecord(root?.req_0);
    if (typeof root?.code !== "number" || typeof result?.code !== "number") {
      throw new QqCredentialVerificationError("protocol_response_invalid");
    }
    if (root.code !== 0 || result.code !== 0) {
      throw new QqCredentialVerificationError("credential_rejected");
    }

    const data = asRecord(result.data);
    const userInfo = asRecord(data?.user_info);
    if (!data || !userInfo || typeof data.login_type !== "number") {
      throw new QqCredentialVerificationError("protocol_response_invalid");
    }
    if (data.login_type <= 0) {
      throw new QqCredentialVerificationError("credential_rejected");
    }

    const verifiedUin = normalizeUin(userInfo.uin);
    if (!verifiedUin) {
      throw new QqCredentialVerificationError("protocol_response_invalid");
    }
    if (verifiedUin !== submittedUin) {
      throw new QqCredentialVerificationError("credential_rejected");
    }
    return { uin: verifiedUin };
  };
}

export const verifyQqCredential = createQqCredentialVerifier(fetchQqLoginStatus);

export function getQqCredentialVerificationMessage(errorType: QqCredentialVerificationErrorType) {
  switch (errorType) {
    case "credential_rejected": return "QQ 音乐凭证已被拒绝。请重试或清除凭证。";
    case "network_failure": return "QQ 音乐凭证验证网络失败。请稍后重试或清除凭证。";
    case "protocol_response_invalid": return "QQ 音乐凭证验证响应异常。请稍后重试或清除凭证。";
  }
}
