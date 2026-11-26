import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { AppError } from "../../../domain/errors.js";
import { isPrivateOrReservedIp, stripIpBrackets } from "../../security/ip-guard.js";
import type { HostResolver } from "../../security/safe-http-client.js";

const QQ_MQTT_HOST = "mu.y.qq.com";
const QQ_MQTT_PORT = 443;
const QQ_MQTT_INITIAL_PATH = "/ws/handshake";
const QQ_MQTT_KEEP_ALIVE_SEC = 45;
const QQ_MQTT_MAX_REDIRECTS = 3;
const QQ_MQTT_CONNECT_TIMEOUT_MS = 12_000;
const MAX_HTTP_UPGRADE_BYTES = 16 * 1024;
const MAX_WS_FRAME_BYTES = 256 * 1024;
const MAX_MQTT_BUFFER_BYTES = 256 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const PROP_SERVER_KEEP_ALIVE = 0x13;
const PROP_AUTH_METHOD = 0x15;
const PROP_SERVER_REFERENCE = 0x1c;
const PROP_REASON_STRING = 0x1f;
const PROP_USER_PROPERTY = 0x26;

const ONE_BYTE_PROPS = new Set([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a]);
const TWO_BYTE_PROPS = new Set([PROP_SERVER_KEEP_ALIVE, 0x21, 0x22, 0x23]);
const FOUR_BYTE_PROPS = new Set([0x02, 0x11, 0x18, 0x27]);
const VARINT_PROPS = new Set([0x0b]);
const UTF8_STRING_PROPS = new Set([
  0x03,
  0x08,
  0x12,
  PROP_AUTH_METHOD,
  0x1a,
  PROP_SERVER_REFERENCE,
  PROP_REASON_STRING,
]);
const BINARY_DATA_PROPS = new Set([0x09, 0x16]);

export type MqttSocketFactory = (options: {
  host: string;
  port: number;
  address: string;
  family: 4 | 6;
}) => Duplex;

export interface QqMqttQrEvent {
  readonly eventType: string;
  readonly payload: unknown;
}

export interface QqMqttQrSubscription {
  close(): void;
}

function encodeVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    let encoded = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) encoded |= 0x80;
    bytes.push(encoded);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function decodeVarInt(buf: Buffer, offset: number): { value: number; nextOffset: number } | null {
  let multiplier = 1;
  let value = 0;
  let idx = offset;
  while (true) {
    if (idx >= buf.length) return null;
    const byte = buf[idx] ?? 0;
    idx += 1;
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: idx };
    }
    multiplier *= 128;
    if (multiplier > 128 * 128 * 128) {
      throw new Error("Malformed MQTT variable byte integer");
    }
  }
}

function encodeUtf8(value: string): Buffer {
  const raw = Buffer.from(value, "utf8");
  const len = Buffer.allocUnsafe(2);
  len.writeUInt16BE(raw.length, 0);
  return Buffer.concat([len, raw]);
}

type OutgoingMqttProp =
  | { readonly id: typeof PROP_AUTH_METHOD; readonly value: string }
  | { readonly id: typeof PROP_USER_PROPERTY; readonly key: string; readonly value: string };

function encodeMqttProperties(entries: readonly OutgoingMqttProp[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.id === PROP_AUTH_METHOD) {
      chunks.push(Buffer.from([PROP_AUTH_METHOD]), encodeUtf8(entry.value));
    } else {
      chunks.push(Buffer.from([PROP_USER_PROPERTY]), encodeUtf8(entry.key), encodeUtf8(entry.value));
    }
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

interface DecodedMqttProperties {
  serverKeepAlive?: number;
  serverReference?: string;
  reasonString?: string;
  userProperties: Record<string, string>;
  nextOffset: number;
}

function decodeMqttProperties(buf: Buffer, offset: number): DecodedMqttProperties {
  const lenRes = decodeVarInt(buf, offset);
  if (!lenRes) {
    throw new Error("Truncated MQTT properties length");
  }
  let idx = lenRes.nextOffset;
  const end = idx + lenRes.value;
  if (end > buf.length) {
    throw new Error("Truncated MQTT properties body");
  }

  const userProperties: Record<string, string> = {};
  let serverKeepAlive: number | undefined;
  let serverReference: string | undefined;
  let reasonString: string | undefined;

  while (idx < end) {
    const propId = buf[idx] ?? 0;
    idx += 1;

    if (propId === PROP_USER_PROPERTY) {
      if (idx + 2 > end) throw new Error("Truncated MQTT user property key");
      const kLen = buf.readUInt16BE(idx);
      idx += 2;
      if (idx + kLen + 2 > end) throw new Error("Truncated MQTT user property value");
      const key = buf.subarray(idx, idx + kLen).toString("utf8");
      idx += kLen;
      const vLen = buf.readUInt16BE(idx);
      idx += 2;
      if (idx + vLen > end) throw new Error("Truncated MQTT user property value bytes");
      const val = buf.subarray(idx, idx + vLen).toString("utf8");
      idx += vLen;
      userProperties[key] = val;
    } else if (UTF8_STRING_PROPS.has(propId)) {
      if (idx + 2 > end) throw new Error("Truncated MQTT UTF-8 property");
      const sLen = buf.readUInt16BE(idx);
      idx += 2;
      if (idx + sLen > end) throw new Error("Truncated MQTT UTF-8 property bytes");
      const str = buf.subarray(idx, idx + sLen).toString("utf8");
      idx += sLen;
      if (propId === PROP_SERVER_REFERENCE) serverReference = str;
      else if (propId === PROP_REASON_STRING) reasonString = str;
    } else if (BINARY_DATA_PROPS.has(propId)) {
      if (idx + 2 > end) throw new Error("Truncated MQTT binary property");
      const bLen = buf.readUInt16BE(idx);
      idx += 2;
      if (idx + bLen > end) throw new Error("Truncated MQTT binary property bytes");
      idx += bLen;
    } else if (ONE_BYTE_PROPS.has(propId)) {
      idx += 1;
    } else if (TWO_BYTE_PROPS.has(propId)) {
      if (idx + 2 > end) throw new Error("Truncated MQTT 2-byte property");
      const num = buf.readUInt16BE(idx);
      idx += 2;
      if (propId === PROP_SERVER_KEEP_ALIVE) serverKeepAlive = num;
    } else if (FOUR_BYTE_PROPS.has(propId)) {
      idx += 4;
    } else if (VARINT_PROPS.has(propId)) {
      const skipped = decodeVarInt(buf, idx);
      if (!skipped) throw new Error("Truncated MQTT varint property");
      idx = skipped.nextOffset;
    } else {
      throw new Error(`Unsupported MQTT 5.0 property id: 0x${propId.toString(16)}`);
    }
  }

  return { serverKeepAlive, serverReference, reasonString, userProperties, nextOffset: end };
}

function buildConnectPacket(clientId: string, keepAliveSec: number, qrcodeId: string): Buffer {
  const variableHeader = Buffer.concat([
    encodeUtf8("MQTT"),
    Buffer.from([0x05, 0x02, (keepAliveSec >> 8) & 0xff, keepAliveSec & 0xff]),
    encodeMqttProperties([
      { id: PROP_AUTH_METHOD, value: "pass" },
      { id: PROP_USER_PROPERTY, key: "tmeAppID", value: "qqmusic" },
      { id: PROP_USER_PROPERTY, key: "business", value: "management" },
      { id: PROP_USER_PROPERTY, key: "hashTag", value: qrcodeId },
      { id: PROP_USER_PROPERTY, key: "clientTag", value: "management.user" },
      { id: PROP_USER_PROPERTY, key: "userID", value: qrcodeId },
    ]),
  ]);
  const payload = encodeUtf8(clientId);
  const remaining = Buffer.concat([variableHeader, payload]);
  return Buffer.concat([Buffer.from([0x10]), encodeVarInt(remaining.length), remaining]);
}

function buildSubscribePacket(packetId: number, topic: string): Buffer {
  const pid = Buffer.allocUnsafe(2);
  pid.writeUInt16BE(packetId, 0);
  const props = encodeMqttProperties([
    { id: PROP_USER_PROPERTY, key: "authorization", value: "tmelogin" },
    { id: PROP_USER_PROPERTY, key: "pubsub", value: "unicast" },
  ]);
  const payload = Buffer.concat([encodeUtf8(topic), Buffer.from([0x00])]);
  const remaining = Buffer.concat([pid, props, payload]);
  return Buffer.concat([Buffer.from([0x82]), encodeVarInt(remaining.length), remaining]);
}

function wrapClientWsFrame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | (opcode & 0x0f), 0x80 | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    throw new Error("Outgoing WebSocket frame exceeds 64 KiB");
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  }
  return Buffer.concat([header, mask, masked]);
}

function buildRedirectPath(currentPath: string, serverReference: string): string {
  const sanitizedRef = serverReference.replace(/[\r\n\s/?#]/g, "");
  if (!sanitizedRef) return currentPath;
  const trimmed = currentPath.replace(/\/+$/, "");
  const segments = trimmed.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last.includes(":")) {
    segments[segments.length - 1] = sanitizedRef;
    return segments.join("/");
  }
  return `${trimmed}/${sanitizedRef}`;
}

async function resolveSafeMqttAddress(
  resolveHost: HostResolver,
): Promise<{ address: string; family: 4 | 6 }> {
  const records = await resolveHost(QQ_MQTT_HOST).catch(() => null);
  if (!records || records.length === 0) {
    throw new AppError("UPSTREAM_ERROR", `无法解析 QQ 音乐扫码推送节点：${QQ_MQTT_HOST}`);
  }
  let chosen: { address: string; family: 4 | 6 } | null = null;
  for (const record of records) {
    const addr = stripIpBrackets(record.address);
    if (isPrivateOrReservedIp(addr)) {
      throw new AppError("UNSAFE_URL", "QQ 音乐扫码推送域名解析到受限内网地址，已拦截。");
    }
    const family: 4 | 6 = record.family === 6 || net.isIPv6(addr) ? 6 : 4;
    if (!chosen || (chosen.family === 6 && family === 4)) {
      chosen = { address: addr, family };
    }
  }
  if (!chosen) {
    throw new AppError("UPSTREAM_ERROR", "未找到可用的 QQ 音乐扫码推送节点地址。");
  }
  return chosen;
}

type AttemptOutcome =
  | { kind: "subscribed"; socket: Duplex; keepAliveSec: number }
  | { kind: "redirect"; serverReference: string };

/**
 * Connects to `wss://mu.y.qq.com:443/ws/handshake` using DNS-pinned TLS + MQTT 5.0 over WebSocket,
 * subscribes to `management.qrcode_login/<qrcodeId>`, and streams real-time scan/confirm events.
 */
export async function subscribeQqMobileQrEvents(options: {
  qrcodeId: string;
  userAgent: string;
  onEvent: (event: QqMqttQrEvent) => void;
  onDisconnect?: (error?: Error) => void;
  resolveHost?: HostResolver;
  socketFactory?: MqttSocketFactory;
  connectTimeoutMs?: number;
}): Promise<QqMqttQrSubscription> {
  const resolveHost: HostResolver =
    options.resolveHost ?? ((hostname) => dns.lookup(hostname, { all: true, verbatim: true }));
  const socketFactory: MqttSocketFactory =
    options.socketFactory ??
    (({ host, port, address }) =>
      tls.connect({
        host: address,
        port,
        servername: host,
      }));
  const connectTimeoutMs = options.connectTimeoutMs ?? QQ_MQTT_CONNECT_TIMEOUT_MS;
  const clientId = `${Date.now()}${Math.floor(1000 + Math.random() * 9000)}`;
  const topic = `management.qrcode_login/${options.qrcodeId}`;

  let currentPath = QQ_MQTT_INITIAL_PATH;
  let activeSocket: Duplex | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let closedByCaller = false;

  const stopPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const closeSubscription = () => {
    if (closedByCaller) return;
    closedByCaller = true;
    stopPing();
    if (activeSocket) {
      try {
        activeSocket.write(wrapClientWsFrame(0x02, Buffer.from([0xe0, 0x00])));
        activeSocket.write(wrapClientWsFrame(0x08, Buffer.alloc(0)));
      } catch {
        // Ignore write errors during teardown
      }
      activeSocket.destroy();
      activeSocket = null;
    }
  };

  const connectCandidate = async (wsPath: string): Promise<AttemptOutcome> => {
    const pinned = await resolveSafeMqttAddress(resolveHost);

    return new Promise<AttemptOutcome>((resolve, reject) => {
      let settled = false;
      let subscribed = false;
      let stage: "http" | "ws" = "http";
      let rawBuf: Buffer = Buffer.alloc(0);
      let wsFragments: Buffer[] = [];
      let wsFragmentsBytes = 0;
      let mqttBuf: Buffer = Buffer.alloc(0);
      let negotiatedKeepAlive = QQ_MQTT_KEEP_ALIVE_SEC;

      const wsKey = crypto.randomBytes(16).toString("base64");
      const expectedAccept = crypto.createHash("sha1").update(`${wsKey}${WS_GUID}`).digest("base64");

      const sock = socketFactory({
        host: QQ_MQTT_HOST,
        port: QQ_MQTT_PORT,
        address: pinned.address,
        family: pinned.family,
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new AppError("UPSTREAM_TIMEOUT", "连接 QQ 音乐扫码实时推送服务超时。"));
        }
      }, connectTimeoutMs);
      timer.unref?.();

      const failHandshake = (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(
            err instanceof AppError
              ? err
              : new AppError("UPSTREAM_ERROR", `QQ 音乐扫码实时通道握手失败：${err.message}`, { cause: err }),
          );
        }
      };

      const handleMqttPackets = () => {
        while (mqttBuf.length >= 2) {
          const firstByte = mqttBuf[0] ?? 0;
          const packetType = firstByte >> 4;
          const remRes = decodeVarInt(mqttBuf, 1);
          if (!remRes) return;
          const packetEnd = remRes.nextOffset + remRes.value;
          if (packetEnd > MAX_MQTT_BUFFER_BYTES) {
            throw new Error("MQTT packet exceeds maximum allowed size");
          }
          if (mqttBuf.length < packetEnd) return;

          const body = mqttBuf.subarray(remRes.nextOffset, packetEnd);
          mqttBuf = mqttBuf.subarray(packetEnd);

          if (packetType === 2) {
            // CONNACK
            if (body.length < 2) throw new Error("Malformed CONNACK packet");
            const reasonCode = body[1] ?? 0xff;
            const props = body.length > 2 ? decodeMqttProperties(body, 2) : null;
            if (props?.serverKeepAlive && props.serverKeepAlive > 0) {
              negotiatedKeepAlive = props.serverKeepAlive;
            }
            if (reasonCode === 0x00) {
              sock.write(wrapClientWsFrame(0x02, buildSubscribePacket(1, topic)));
              continue;
            }
            if ((reasonCode === 0x9c || reasonCode === 0x9d) && props?.serverReference) {
              clearTimeout(timer);
              settled = true;
              sock.destroy();
              resolve({ kind: "redirect", serverReference: props.serverReference });
              return;
            }
            throw new Error(
              `MQTT CONNACK rejected with code 0x${reasonCode.toString(16)}${props?.reasonString ? ` (${props.reasonString})` : ""}`,
            );
          }

          if (packetType === 9) {
            // SUBACK
            if (body.length < 3) throw new Error("Malformed SUBACK packet");
            const props = decodeMqttProperties(body, 2);
            const reasonCodes = [...body.subarray(props.nextOffset)];
            if (reasonCodes.length === 0 || reasonCodes.some((c) => c >= 0x80)) {
              throw new Error(`MQTT SUBACK rejected (${reasonCodes.join(",")})`);
            }
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              subscribed = true;
              resolve({ kind: "subscribed", socket: sock, keepAliveSec: negotiatedKeepAlive });
            }
            continue;
          }

          if (packetType === 3) {
            // PUBLISH
            const qos = (firstByte >> 1) & 0x03;
            if (body.length < 2) continue;
            const topicLen = body.readUInt16BE(0);
            let idx = 2 + topicLen;
            if (idx > body.length) continue;

            if (qos > 0) {
              if (idx + 2 > body.length) continue;
              const packetId = body.subarray(idx, idx + 2);
              idx += 2;
              if (qos === 1 && !closedByCaller) {
                sock.write(wrapClientWsFrame(0x02, Buffer.concat([Buffer.from([0x40, 0x02]), packetId])));
              }
            }

            const props = decodeMqttProperties(body, idx);
            const payloadBytes = body.subarray(props.nextOffset);
            let parsedJson: unknown = null;
            if (payloadBytes.length > 0) {
              try {
                parsedJson = JSON.parse(payloadBytes.toString("utf8"));
              } catch {
                parsedJson = null;
              }
            }
            const eventType = props.userProperties.type ?? "";
            if (eventType && !closedByCaller) {
              options.onEvent({ eventType, payload: parsedJson });
            }
            continue;
          }

          if (packetType === 14) {
            // Server DISCONNECT
            sock.destroy();
            return;
          }
        }
      };

      const sendUpgradeRequest = () => {
        const upgradeLines = [
          `GET ${wsPath} HTTP/1.1`,
          `Host: ${QQ_MQTT_HOST}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${wsKey}`,
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Protocol: mqtt",
          "Origin: https://y.qq.com",
          "Referer: https://y.qq.com/",
          `User-Agent: ${options.userAgent}`,
          "\r\n",
        ];
        sock.write(upgradeLines.join("\r\n"));
      };

      if (sock instanceof tls.TLSSocket) {
        sock.once("secureConnect", sendUpgradeRequest);
      } else {
        queueMicrotask(sendUpgradeRequest);
      }

      sock.on("data", (chunk: Buffer | Uint8Array) => {
        try {
          const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          rawBuf = rawBuf.length === 0 ? bufChunk : Buffer.concat([rawBuf, bufChunk]);

          if (stage === "http") {
            const headerEnd = rawBuf.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
              if (rawBuf.length > MAX_HTTP_UPGRADE_BYTES) {
                throw new Error("WebSocket upgrade header exceeded limit");
              }
              return;
            }
            const rawHeader = rawBuf.subarray(0, headerEnd).toString("utf8");
            const lines = rawHeader.split("\r\n");
            const statusLine = lines[0] ?? "";
            if (!/^HTTP\/1\.1\s+101\b/i.test(statusLine)) {
              throw new Error(`Unexpected WebSocket status: ${statusLine}`);
            }
            const acceptLine = lines.find((line) => line.toLowerCase().startsWith("sec-websocket-accept:"));
            const actualAccept = acceptLine?.split(":")[1]?.trim() ?? "";
            if (actualAccept !== expectedAccept) {
              throw new Error("Invalid Sec-WebSocket-Accept header");
            }

            rawBuf = rawBuf.subarray(headerEnd + 4);
            stage = "ws";
            sock.write(
              wrapClientWsFrame(0x02, buildConnectPacket(clientId, QQ_MQTT_KEEP_ALIVE_SEC, options.qrcodeId)),
            );
          }

          while (rawBuf.length >= 2) {
            const b0 = rawBuf[0] ?? 0;
            const b1 = rawBuf[1] ?? 0;
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let payloadLen = b1 & 0x7f;
            let headerLen = 2;

            if (payloadLen === 126) {
              if (rawBuf.length < 4) return;
              payloadLen = rawBuf.readUInt16BE(2);
              headerLen = 4;
            } else if (payloadLen === 127) {
              if (rawBuf.length < 10) return;
              const bigLen = rawBuf.readBigUInt64BE(2);
              if (bigLen > BigInt(MAX_WS_FRAME_BYTES)) {
                throw new Error("WebSocket frame exceeded maximum size");
              }
              payloadLen = Number(bigLen);
              headerLen = 10;
            }

            if (payloadLen > MAX_WS_FRAME_BYTES) {
              throw new Error("WebSocket frame exceeded maximum size");
            }

            const maskBytesLen = masked ? 4 : 0;
            const frameTotal = headerLen + maskBytesLen + payloadLen;
            if (rawBuf.length < frameTotal) return;

            let framePayload = rawBuf.subarray(headerLen + maskBytesLen, frameTotal);
            if (masked) {
              const mask = rawBuf.subarray(headerLen, headerLen + 4);
              const unmasked = Buffer.from(framePayload);
              for (let i = 0; i < unmasked.length; i += 1) {
                unmasked[i] = (unmasked[i] ?? 0) ^ (mask[i & 3] ?? 0);
              }
              framePayload = unmasked;
            }
            rawBuf = rawBuf.subarray(frameTotal);

            if (opcode === 0x09) {
              // Ping -> Pong
              if (!closedByCaller) {
                sock.write(wrapClientWsFrame(0x0a, framePayload));
              }
              continue;
            }
            if (opcode === 0x0a) {
              continue;
            }
            if (opcode === 0x08) {
              sock.destroy();
              return;
            }
            if (opcode === 0x02 || opcode === 0x00) {
              if (fin && wsFragments.length === 0) {
                mqttBuf = mqttBuf.length === 0 ? framePayload : Buffer.concat([mqttBuf, framePayload]);
                if (mqttBuf.length > MAX_MQTT_BUFFER_BYTES) {
                  throw new Error("MQTT receive buffer exceeded limit");
                }
                handleMqttPackets();
              } else {
                wsFragmentsBytes += framePayload.length;
                if (wsFragmentsBytes > MAX_WS_FRAME_BYTES) {
                  throw new Error("Fragmented WebSocket message exceeded limit");
                }
                wsFragments.push(Buffer.from(framePayload));
                if (fin) {
                  const combined = Buffer.concat(wsFragments);
                  wsFragments = [];
                  wsFragmentsBytes = 0;
                  mqttBuf = mqttBuf.length === 0 ? combined : Buffer.concat([mqttBuf, combined]);
                  handleMqttPackets();
                }
              }
            }
          }
        } catch (err) {
          const wrapped = err instanceof Error ? err : new Error(String(err));
          if (!settled) {
            failHandshake(wrapped);
          } else {
            sock.destroy(wrapped);
          }
        }
      });

      sock.once("error", (err) => {
        if (!settled) {
          failHandshake(err);
        } else if (subscribed && !closedByCaller) {
          stopPing();
          options.onDisconnect?.(err);
        }
      });

      sock.once("close", () => {
        stopPing();
        if (!settled) {
          failHandshake(new Error("WebSocket closed before SUBACK"));
        } else if (subscribed && !closedByCaller) {
          options.onDisconnect?.();
        }
      });
    });
  };

  for (let hop = 0; hop <= QQ_MQTT_MAX_REDIRECTS; hop += 1) {
    const outcome = await connectCandidate(currentPath);
    if (outcome.kind === "subscribed") {
      if (closedByCaller) {
        outcome.socket.destroy();
        return { close: closeSubscription };
      }
      activeSocket = outcome.socket;
      const pingIntervalMs = Math.max(10_000, Math.floor(outcome.keepAliveSec * 750));
      pingTimer = setInterval(() => {
        if (!activeSocket || closedByCaller) return;
        try {
          activeSocket.write(wrapClientWsFrame(0x02, Buffer.from([0xc0, 0x00])));
        } catch {
          // Socket close listener handles unexpected drops
        }
      }, pingIntervalMs);
      pingTimer.unref?.();
      return { close: closeSubscription };
    }

    if (hop >= QQ_MQTT_MAX_REDIRECTS) {
      throw new AppError("UPSTREAM_ERROR", "QQ 音乐扫码推送节点重定向次数过多。");
    }
    currentPath = buildRedirectPath(currentPath, outcome.serverReference);
  }

  throw new AppError("UPSTREAM_ERROR", "连接 QQ 音乐扫码推送节点失败。");
}
