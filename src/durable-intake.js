import { createInboxEnvelope } from "./inbox-envelope.js";

export class DurableIntake {
  constructor({ store, rules, sourceSha256, mode, selfUserId, reputationPolicy = null, reputationPolicyKey = null,
    maxPendingNotes, logger, onStateChange = () => {} }) {
    this.store = store;
    this.rules = rules;
    this.options = { sourceSha256, mode, selfUserId, reputationPolicy };
    this.reputationPolicyKey = reputationPolicyKey;
    this.cached = 0;
    this.capacity = maxPendingNotes;
    this.logger = logger;
    this.onStateChange = onStateChange;
    this.accepting = true;
    this.inflight = new Set();
    this.accepted = 0;
    this.duplicates = 0;
    this.rejected = 0;
    this.failed = 0;
  }

  submit(note) {
    if (!this.accepting) return this.reject(note?.id, "Intake is closed.", "INGEST_CLOSED");
    const envelope = createInboxEnvelope(note, this.rules, this.options);
    if (!envelope) return Promise.resolve(false);
    if (this.inflight.size >= this.capacity) {
      return this.reject(envelope.noteId, "Intake write capacity has been reached.", "INGEST_BACKPRESSURE");
    }
    // Only the body-free classification is captured by the persistence promise.
    let operation;
    operation = this.persist(envelope).then(({ inserted, cached }) => {
        if (inserted) this.accepted += 1;
        else if (cached) this.cached += 1;
        else this.duplicates += 1;
        return inserted;
      })
      .catch((error) => {
        this.failed += 1;
        throw error;
      })
      .finally(() => {
        this.inflight.delete(operation);
        this.onStateChange(this.snapshot());
      });
    this.inflight.add(operation);
    this.onStateChange(this.snapshot());
    return operation;
  }

  async persist(envelope) {
    if (envelope.schemaVersion === 2 && this.reputationPolicyKey &&
        await this.store.getReputation(envelope.userId, this.reputationPolicyKey)) return { inserted: false, cached: true };
    return this.store.enqueue(envelope);
  }

  reject(noteId, message, code) {
    this.rejected += 1;
    this.logger.warn("Durable intake rejected a note", { noteId, code });
    this.onStateChange(this.snapshot());
    return Promise.reject(Object.assign(new Error(message), { code }));
  }

  snapshot() {
    return {
      pending: this.inflight.size, capacity: this.capacity, rejected: this.rejected,
      failed: this.failed, accepted: this.accepted, duplicates: this.duplicates, cached: this.cached,
    };
  }

  close() {
    this.accepting = false;
    return Promise.allSettled([...this.inflight]);
  }
}
