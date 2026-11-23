import type { UserRole } from "#shared";

/**
 * Explicit immutable actor passed down through all Application Use-Cases.
 * Eliminates implicit AsyncLocalStorage context leaking across background jobs.
 */
export interface ActorContext {
  readonly userId: string;
  readonly username: string;
  readonly role: UserRole;
  readonly trustedFallback: boolean;
}
