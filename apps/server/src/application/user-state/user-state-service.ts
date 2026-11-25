import type { PlayHistoryResponse, PlayerState, Song, UpdateUserSettingsInput, UserSettings } from "#shared";
import type { ActorContext } from "../../domain/context.js";
import type { UserStateRepository } from "../../infrastructure/db/repositories/user-state-repository.js";

export class UserStateService {
  readonly #repo: UserStateRepository;

  constructor(deps: { userStateRepo: UserStateRepository }) {
    this.#repo = deps.userStateRepo;
  }

  getSettings(actor: ActorContext): UserSettings {
    return this.#repo.getSettings(actor.userId);
  }

  updateSettings(actor: ActorContext, patch: UpdateUserSettingsInput): UserSettings {
    return this.#repo.updateSettings(actor.userId, patch);
  }

  getPlayerState(actor: ActorContext): PlayerState {
    return this.#repo.getPlayerState(actor.userId);
  }

  savePlayerState(actor: ActorContext, input: PlayerState): PlayerState {
    return this.#repo.savePlayerState(actor.userId, input);
  }

  getPlayHistory(actor: ActorContext): PlayHistoryResponse {
    return this.#repo.getPlayHistoryWithRevision(actor.userId);
  }

  recordPlayHistory(actor: ActorContext, song: Song): PlayHistoryResponse {
    return this.#repo.recordPlayHistoryWithRevision(actor.userId, song);
  }

  clearPlayHistory(actor: ActorContext): PlayHistoryResponse {
    return this.#repo.clearPlayHistoryWithRevision(actor.userId);
  }

  getSearchHistory(actor: ActorContext): string[] {
    return this.#repo.getSearchHistory(actor.userId);
  }

  addSearchHistory(actor: ActorContext, keyword: string): string[] {
    return this.#repo.addSearchHistory(actor.userId, keyword);
  }

  deleteSearchHistory(actor: ActorContext, keyword?: string): string[] {
    if (keyword !== undefined) {
      const trimmed = keyword.trim();
      if (!trimmed) {
        return this.#repo.getSearchHistory(actor.userId);
      }
      return this.#repo.removeSearchHistory(actor.userId, trimmed);
    }
    this.#repo.clearSearchHistory(actor.userId);
    return [];
  }
}
