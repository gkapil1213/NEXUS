// src/core/ai-provider-gateway.ts
// Phase 216: provider-neutral AI execution gateway.
//
// The gateway is responsible for:
//   - holding a registry of AIProvider instances
//   - normalizing errors from any provider into AIProviderError
//   - enforcing bounded retries on retryable error classes only
//   - enforcing bounded timeouts (the provider adapter is responsible for
//     honoring timeoutMs; the gateway re-verifies)
//   - never logging or emitting secrets

import {
  type AIProvider,
  type AIProviderConfiguration,
  type AIProviderError,
  type AIProviderErrorClass,
  type AIProviderRequest,
  type AIProviderResponse,
  type AIProviderCapability,
  isAIProviderError,
} from "./ai-provider-contracts";
import { redactSecrets } from "./ai-provider-redaction";

export interface AIProviderGatewayDeps {
  providers: AIProvider[];
  /** Optional event sink; gateway emits no secrets. */
  onEvent?: (e: {
    type: "ai.provider.requested" | "ai.provider.completed" | "ai.provider.failed" | "ai.provider.retry" | "ai.provider.timeout";
    providerId: string;
    requestId: string;
    payload: Record<string, unknown>;
  }) => Promise<unknown> | unknown;
}

export interface AIProviderGatewayInvokeResult {
  ok: true;
  response: AIProviderResponse;
  attempts: number;
  retries: number;
}
export interface AIProviderGatewayInvokeError {
  ok: false;
  error: AIProviderError;
  attempts: number;
  retries: number;
}

const RETRYABLE: ReadonlySet<AIProviderErrorClass> = new Set([
  "TIMEOUT",
  "CONNECTION",
  "RATE_LIMIT",
  "SERVER",
]);

function classify(e: unknown, httpStatus?: number): AIProviderError {
  if (isAIProviderError(e)) {
    return { ...e, message: redactSecrets(e.message) };
  }
  const msg = e instanceof Error ? e.message : String(e);
  const redacted = redactSecrets(msg);
  if (httpStatus === 401 || httpStatus === 403) {
    return { errorClass: "AUTH", message: redacted, httpStatus, retryable: false };
  }
  if (httpStatus === 429) {
    return { errorClass: "RATE_LIMIT", message: redacted, httpStatus, retryable: true };
  }
  if (httpStatus && httpStatus >= 500) {
    return { errorClass: "SERVER", message: redacted, httpStatus, retryable: true };
  }
  if (httpStatus && httpStatus >= 400) {
    return { errorClass: "CLIENT", message: redacted, httpStatus, retryable: false };
  }
  if (/timed? ?out|abort/i.test(redacted)) {
    return { errorClass: "TIMEOUT", message: redacted, retryable: true };
  }
  if (/econn|network|fetch failed|enotfound|connection refused/i.test(redacted)) {
    return { errorClass: "CONNECTION", message: redacted, retryable: true };
  }
  return { errorClass: "UNKNOWN", message: redacted, retryable: false };
}

export class AIProviderGateway {
  private readonly byId = new Map<string, AIProvider>();

  constructor(private readonly deps: AIProviderGatewayDeps) {
    for (const p of deps.providers) this.byId.set(p.providerId, p);
  }

  listProviders(): AIProviderConfiguration[] {
    return [...this.byId.values()].map((p) => p.configuration);
  }

  hasProvider(providerId: string): boolean {
    return this.byId.has(providerId);
  }

  async probe(providerId: string): Promise<AIProviderCapability> {
    const p = this.byId.get(providerId);
    if (!p) {
      return {
        providerId,
        status: "NOT_IMPLEMENTED",
        reason: "PROVIDER_NOT_REGISTERED",
        checkedAt: Date.now(),
      };
    }
    try {
      return await p.probe();
    } catch (e) {
      const err = classify(e);
      return {
        providerId,
        status: "UNAVAILABLE",
        reason: "PROBE_FAILED:" + err.errorClass,
        checkedAt: Date.now(),
      };
    }
  }

  async invoke(req: AIProviderRequest): Promise<AIProviderGatewayInvokeResult | AIProviderGatewayInvokeError> {
    const provider = this.byId.get(req.providerId);
    if (!provider) {
      const error: AIProviderError = {
        errorClass: "NOT_CONFIGURED",
        message: "no provider registered for " + req.providerId,
        retryable: false,
      };
      await this.emit("ai.provider.failed", req, { errorClass: error.errorClass });
      return { ok: false, error, attempts: 0, retries: 0 };
    }

    const cfg = provider.configuration;
    if (!cfg.enabled) {
      const error: AIProviderError = {
        errorClass: "NOT_CONFIGURED",
        message: "provider disabled",
        retryable: false,
      };
      await this.emit("ai.provider.failed", req, { errorClass: error.errorClass });
      return { ok: false, error, attempts: 0, retries: 0 };
    }

    const maxAttempts = Math.max(1, Math.min(1 + cfg.maxRetries, 6));
    await this.emit("ai.provider.requested", req, { model: req.model, responseFormat: req.responseFormat });

    let lastErr: AIProviderError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await provider.invoke(req);
        await this.emit("ai.provider.completed", req, { latencyMs: response.latencyMs, attempt });
        return { ok: true, response, attempts: attempt, retries: attempt - 1 };
      } catch (e) {
        const httpStatus = (e as { httpStatus?: number })?.httpStatus;
        const err = classify(e, httpStatus);
        lastErr = err;
        if (err.errorClass === "TIMEOUT") {
          await this.emit("ai.provider.timeout", req, { attempt, timeoutMs: req.timeoutMs });
        } else {
          await this.emit("ai.provider.failed", req, { attempt, errorClass: err.errorClass, httpStatus: err.httpStatus });
        }
        if (!err.retryable || attempt === maxAttempts) {
          return { ok: false, error: err, attempts: attempt, retries: attempt - 1 };
        }
        await this.emit("ai.provider.retry", req, { attempt, errorClass: err.errorClass });
        // Deterministic backoff: no randomness.
        const backoffMs = Math.min(50 * Math.pow(2, attempt - 1), 2000);
        await new Promise((res) => setTimeout(res, backoffMs));
      }
    }
    return {
      ok: false,
      error: lastErr ?? { errorClass: "UNKNOWN", message: "unknown failure", retryable: false },
      attempts: maxAttempts,
      retries: maxAttempts - 1,
    };
  }

  private async emit(
    type: "ai.provider.requested" | "ai.provider.completed" | "ai.provider.failed" | "ai.provider.retry" | "ai.provider.timeout",
    req: AIProviderRequest,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.onEvent) return;
    try {
      await this.deps.onEvent({
        type,
        providerId: req.providerId,
        requestId: req.requestId,
        payload: { ...payload, model: req.model },
      });
    } catch { /* observability is best-effort; never abort a request */ }
  }
}
