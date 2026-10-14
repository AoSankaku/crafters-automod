import { FileHumanAuthority } from "./human-authority.js";

/** PostgreSQL decisions are shared by every process; SQLite also honors the local file. */
export class SharedHumanAuthority {
  constructor({ store, localPath, logger }) {
    this.store = store;
    this.local = localPath ? new FileHumanAuthority(localPath, logger) : null;
  }

  async hasHumanDecision(moderationCase) {
    return await this.store.hasHumanDecision(moderationCase) ||
      Boolean(this.local && await this.local.hasHumanDecision(moderationCase));
  }
}
