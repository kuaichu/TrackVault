import type { QrStartResult } from "#shared";
import { AppError } from "../../../domain/errors.js";
import type {
  CredentialVerificationResult,
  ProviderQrCheckResult,
} from "../../../domain/ports/music-provider.js";
import { QrSessionStore } from "../common/qr-session-store.js";
import type { NeteaseRpcClient } from "./netease-rpc-client.js";

export class NeteaseQrAuthManager {
  readonly #rpc: NeteaseRpcClient;
  readonly #sessions = new QrSessionStore<{ createdAt: number }>();

  constructor(rpc: NeteaseRpcClient) {
    this.#rpc = rpc;
  }

  invalidateScope(scopeKey: string): void {
    this.#sessions.invalidateScope(scopeKey);
  }

  async start(scopeKey: string): Promise<QrStartResult> {
    const keyRes = await this.#rpc.call(() =>
      this.#rpc.api.login_qr_key(this.#rpc.baseParams(undefined, { timestamp: Date.now() })),
    );
    const key = (keyRes.body.data as { unikey?: string } | undefined)?.unikey;
    if (!key) {
      throw new AppError("UPSTREAM_ERROR", "网易云二维码登录初始化失败。");
    }

    const qrRes = await this.#rpc.call(() =>
      this.#rpc.api.login_qr_create(
        this.#rpc.baseParams(undefined, { key, platform: "web", qrimg: true, timestamp: Date.now() }),
      ),
    );
    const data = qrRes.body.data as { qrimg?: string; qrurl?: string } | undefined;
    if (!data?.qrimg) {
      throw new AppError("UPSTREAM_ERROR", "网易云二维码生成失败。");
    }

    this.#sessions.set(scopeKey, key, { createdAt: Date.now() });
    return { key, qrImage: data.qrimg, qrUrl: data.qrurl };
  }

  async check(
    scopeKey: string,
    key: string,
    verifyCredential: (cookie: string) => Promise<CredentialVerificationResult>,
  ): Promise<ProviderQrCheckResult> {
    const trimmedKey = key.trim();
    const session = this.#sessions.get(scopeKey, trimmedKey);
    if (!session) {
      return { status: "expired", code: 800, message: "二维码已过期或不属于当前账号，请重新生成。" };
    }

    const response = await this.#rpc.call(() =>
      this.#rpc.api.login_qr_check(
        this.#rpc.baseParams(undefined, { key: trimmedKey, noCookie: true, timestamp: Date.now() }),
      ),
    );
    const code = Number(response.body.code ?? 0);
    const message = typeof response.body.message === "string" ? response.body.message : "";
    const rawCookie = typeof response.body.cookie === "string" ? response.body.cookie : undefined;

    if (code === 800) {
      this.#sessions.delete(scopeKey, trimmedKey);
      return { status: "expired", code, message: message || "二维码已过期，请刷新。" };
    }
    if (code === 801) return { status: "waiting", code, message: message || "等待网易云 App 扫码。" };
    if (code === 802) return { status: "scanned", code, message: message || "已扫码，请在手机确认。" };
    if (code === 803 && rawCookie) {
      this.#sessions.delete(scopeKey, trimmedKey);
      const verification = await verifyCredential(rawCookie);
      return {
        status: "confirmed",
        code,
        message: verification.message,
        rawCookie,
        verification,
      };
    }

    return { status: "error", code, message: message || "二维码登录状态异常。" };
  }
}
