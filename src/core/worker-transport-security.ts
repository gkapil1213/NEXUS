export class WorkerTransportSecurity {
  private seenMessageIds = new Set<string>();
  private seenSequences = new Map<string, number>();

  validateFreshMessage(messageId: string, sessionId: string, sequence?: number): { valid: boolean; reason?: string } {
    if (this.seenMessageIds.has(messageId)) {
      return { valid: false, reason: "duplicate_message" };
    }
    if (sequence !== undefined) {
      const last = this.seenSequences.get(sessionId) ?? 0;
      if (sequence <= last) {
        return { valid: false, reason: "invalid_sequence" };
      }
    }
    return { valid: true };
  }

  acceptMessage(messageId: string, sessionId: string, sequence?: number): void {
    this.seenMessageIds.add(messageId);
    if (sequence !== undefined) {
      this.seenSequences.set(sessionId, sequence);
    }
  }
}
