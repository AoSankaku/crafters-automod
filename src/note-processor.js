/** A bounded, serial receiver that drains accepted notes during shutdown. */
export class NoteProcessor {
  constructor({ processNote, maxPendingNotes, logger, onStateChange = () => {} }) {
    if (!Number.isInteger(maxPendingNotes) || maxPendingNotes < 1) {
      throw new Error("Note processing capacity must be a positive integer.");
    }
    this.processNote = processNote;
    this.capacity = maxPendingNotes;
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.pending = 0;
    this.rejected = 0;
    this.failed = 0;
    this.accepting = true;
    this.processing = Promise.resolve();
  }

  submit(note) {
    if (!this.accepting || this.pending >= this.capacity) {
      this.rejected += 1;
      this.logger.warn("Note processing rejected", {
        noteId: note?.id,
        reason: this.accepting ? "capacity" : "shutdown",
        capacity: this.capacity,
      });
      this.onStateChange(this.snapshot());
      return false;
    }

    this.pending += 1;
    this.onStateChange(this.snapshot());
    this.processing = this.processing
      .then(() => this.processNote(note))
      .catch((error) => {
        this.failed += 1;
        this.logger.error("Unexpected note processing failure", error, { noteId: note?.id });
      })
      .finally(() => {
        this.pending -= 1;
        this.onStateChange(this.snapshot());
      });
    return true;
  }

  snapshot() {
    return { pending: this.pending, capacity: this.capacity, rejected: this.rejected, failed: this.failed };
  }

  close() {
    this.accepting = false;
    return this.processing;
  }
}
