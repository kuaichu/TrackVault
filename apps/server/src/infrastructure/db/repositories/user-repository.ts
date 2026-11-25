import crypto from "node:crypto";
import type { UserRole, UserSummary } from "#shared";
import type { SqliteClient } from "../client.js";

const SESSION_LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export interface UserRecord extends UserSummary {
  passwordHash: string;
}

interface RawUserRow {
  id: string;
  username: string;
  password_hash: string;
  role: UserRole;
  trusted_fallback: number;
  created_at: number;
}

function mapUser(row: RawUserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    trustedFallback: Boolean(row.trusted_fallback),
    createdAt: row.created_at,
  };
}

export function toUserSummary(record: UserRecord): UserSummary {
  return {
    id: record.id,
    username: record.username,
    role: record.role,
    trustedFallback: record.trustedFallback,
    createdAt: record.createdAt,
  };
}

export class UserRepository {
  readonly #sqlite: SqliteClient;

  constructor(sqlite: SqliteClient) {
    this.#sqlite = sqlite;
  }

  countUsers(): number {
    const row = this.#sqlite.db.prepare("SELECT COUNT(*) as total FROM users").get() as {
      total: number;
    };
    return row.total;
  }

  listUsers(): UserSummary[] {
    const rows = this.#sqlite.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as unknown as RawUserRow[];
    return rows.map((row) => toUserSummary(mapUser(row)));
  }

  findById(id: string): UserRecord | null {
    const row = this.#sqlite.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as RawUserRow | undefined;
    return row ? mapUser(row) : null;
  }

  findByUsername(username: string): UserRecord | null {
    const row = this.#sqlite.db
      .prepare("SELECT * FROM users WHERE lower(username) = lower(?)")
      .get(username.trim()) as RawUserRow | undefined;
    return row ? mapUser(row) : null;
  }

  createUser(input: {
    username: string;
    passwordHash: string;
    role: UserRole;
    trustedFallback: boolean;
  }): UserSummary {
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    this.#sqlite.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, trusted_fallback, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.username.trim(),
        input.passwordHash,
        input.role,
        input.trustedFallback ? 1 : 0,
        createdAt,
      );

    return {
      id,
      username: input.username.trim(),
      role: input.role,
      trustedFallback: input.trustedFallback,
      createdAt,
    };
  }

  updateUser(
    id: string,
    patch: { role?: UserRole; trustedFallback?: boolean; passwordHash?: string },
  ): UserSummary | null {
    const current = this.findById(id);
    if (!current) return null;

    const nextRole = patch.role ?? current.role;
    const nextTrusted = patch.trustedFallback ?? current.trustedFallback;
    const nextHash = patch.passwordHash ?? current.passwordHash;

    this.#sqlite.db
      .prepare("UPDATE users SET role = ?, trusted_fallback = ?, password_hash = ? WHERE id = ?")
      .run(nextRole, nextTrusted ? 1 : 0, nextHash, id);

    return {
      id: current.id,
      username: current.username,
      role: nextRole,
      trustedFallback: nextTrusted,
      createdAt: current.createdAt,
    };
  }

  deleteUser(id: string): boolean {
    const result = this.#sqlite.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createSession(tokenHash: string, userId: string, ttlMs: number): void {
    const now = Date.now();
    this.#sqlite.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(tokenHash, userId, now + ttlMs, now, now);
  }

  findValidSessionUser(tokenHash: string): UserSummary | null {
    const now = Date.now();
    const row = this.#sqlite.db
      .prepare(
        `SELECT u.*, s.last_seen_at AS session_last_seen_at FROM sessions s
         INNER JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as (RawUserRow & { session_last_seen_at: number }) | undefined;

    if (!row) return null;

    if (now - row.session_last_seen_at >= SESSION_LAST_SEEN_THROTTLE_MS) {
      this.#sqlite.db
        .prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
        .run(now, tokenHash);
    }

    return toUserSummary(mapUser(row));
  }

  deleteSession(tokenHash: string): void {
    this.#sqlite.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteUserSessions(userId: string): void {
    this.#sqlite.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  purgeExpiredSessions(): void {
    this.#sqlite.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  }
}
