import { RetryPolicy } from "./execution-models";

export class RetryEngine {
  calculateNextAttempt(currentAttempt: number, policy: RetryPolicy, now: number): number | null {
    if (currentAttempt >= policy.maxAttempts) return null;
    const delay = Math.min(
      policy.initialDelayMs * Math.pow(policy.multiplier, currentAttempt - 1),
      policy.maxDelayMs
    );
    return now + delay;
  }

  isRetryable(error: Error | string, policy: RetryPolicy): boolean {
    const msg = typeof error === "string" ? error : error.message;
    if (policy.retryableErrors && policy.retryableErrors.length > 0) {
      return policy.retryableErrors.some((e) => msg.includes(e));
    }
    return true; // by default, all errors are retryable unless policy says otherwise
  }
}
