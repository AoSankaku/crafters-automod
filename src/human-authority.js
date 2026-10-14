import { readFile } from "node:fs/promises";

export class FileHumanAuthority {
  constructor(path, logger) {
    this.path = path;
    this.logger = logger;
  }

  async hasHumanDecision({ caseId, noteId, userId }) {
    try {
      const raw = await readFile(this.path, "utf8");
      const overrides = JSON.parse(raw);
      validateOverrides(overrides);
      return (
        overrides.caseIds.includes(caseId) ||
        overrides.noteIds.includes(noteId) ||
        overrides.userIds.includes(userId)
      );
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      this.logger.error("Human override file is invalid; failing closed", new Error("Human override state is unavailable or invalid."));
      return true;
    }
  }
}

function validateOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") throw new Error("Human overrides must be an object.");
  for (const field of ["caseIds", "noteIds", "userIds"]) {
    if (!Array.isArray(overrides[field]) || !overrides[field].every((value) => typeof value === "string")) {
      throw new Error(`Human overrides ${field} must be an array of strings.`);
    }
  }
}
