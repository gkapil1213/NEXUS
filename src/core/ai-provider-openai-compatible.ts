// src/core/ai-provider-openai-compatible.ts
// Phase 216: real HTTP provider adapter for OpenAI-compatible /chat/completions.
//
// Performs a real network fetch when invoked. Reads the API key only from the
// environment variable named in the configuration — the key value is never
// stored on the object, never logged, never returned in responses or errors.

import {
  type AIProvider,
  type AIProviderCapability,
  type AIProviderConfiguration,
  type AIProviderError,
  type AIProviderRequest,
  type AIProviderResponse,
} from "./ai-provider-contracts";
import { redactSecrets, bounded } from "./ai-provider-redaction";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

export class OpenAICompatibleProvider implements AIProvider {
  readonly providerId: string;

  constructor(readonly configuration: AIProviderConfiguration) {
    this.providerId = configuration.providerId;
  }

  private readApiKey(): string | null {
    const envName = this.configuration.apiKeyEnvVar;
    if (!envName) return null;
    const v = process.env[envName];
    if (typeof v !== "string" || v.length === 0) return null;
    return v;
  }

  async probe(): Promise<AIProviderCapability> {
    const now = Date.now();
    if (!this.configuration.enabled) {
      return { providerId: this.providerId, status: "UNAVAILABLE", reason: "PROVIDER_DISABLED", checkedAt: now };
    }
    if (!this.configuration.endpoint) {
      return { providerId: this.providerId, status: "UNAVAILABLE", reason: "ENDPOINT_MISSING", checkedAt: now };
    }
    const key = this.readApiKey();
    if (!key) {
      return { providerId: this.providerId, status: "UNAVAILABLE", reason: "PROVIDER_NOT_CONFIGURED", checkedAt: now };
    }
    const url = this.configuration.endpoint.replace(/\/+$/, "") + "/models";
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(PROBE_TIMEOUT_MS, this.configuration.timeoutMs));
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: "Bearer " + key },
        signal: controller.signal,
      });
      const latency = Date.now() - t0;
      if (res.status === 401 || res.status === 403) {
        return { providerId: this.providerId, status: "UNAVAILABLE", reason: "PROVIDER_AUTH_FAILED", checkedAt: Date.now(), latencyMs: latency };
      }
      if (!res.ok) {
        return { providerId: this.providerId, status: "UNAVAILABLE", reason: "PROVIDER_UNAVAILABLE:HTTP_" + res.status, checkedAt: Date.now(), latencyMs: latency };
      }
      return { providerId: this.providerId, status: "AVAILABLE", reason: "PROBE_OK", checkedAt: Date.now(), latencyMs: latency };
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : String(e));
      return { providerId: this.providerId, status: "UNAVAILABLE", reason: "PROBE_FAILED:" + msg, checkedAt: Date.now() };
    } finally {
      clearTimeout(timer);
    }
  }

  async invoke(req: AIProviderRequest): Promise<AIProviderResponse> {
    const cfg = this.configuration;
    if (!cfg.enabled) throw this.error("NOT_CONFIGURED", "provider disabled", false);
    const key = this.readApiKey();
    if (!key) throw this.error("NOT_CONFIGURED", "provider API key environment variable is not set", false);
    if (!cfg.endpoint) throw this.error("NOT_CONFIGURED", "provider endpoint not configured", false);

    const systemPrompt = bounded(req.systemPrompt ?? "", MAX_REQUEST_BYTES / 2);
    const userPrompt = bounded(req.userPrompt ?? "", MAX_REQUEST_BYTES / 2);

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (cfg.structuredOutput && req.responseFormat === "json_object") {
      body.response_format = { type: "json_object" };
    }

    const url = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Math.min(req.timeoutMs || cfg.timeoutMs, cfg.timeoutMs * 4));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = redactSecrets(e instanceof Error ? e.message : String(e));
      if (/abort/i.test(msg)) throw this.error("TIMEOUT", "provider call exceeded " + timeoutMs + "ms", true);
      throw this.error("CONNECTION", msg, true);
    }
    clearTimeout(timer);

    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const text = bounded(redactSecrets(await res.text().catch(() => "")), 4000);
      const cls: AIProviderError["errorClass"] =
        res.status === 401 || res.status === 403 ? "AUTH"
        : res.status === 429 ? "RATE_LIMIT"
        : res.status >= 500 ? "SERVER"
        : res.status >= 400 ? "CLIENT"
        : "UNKNOWN";
      const retryable = cls === "RATE_LIMIT" || cls === "SERVER";
      const err = this.error(cls, `HTTP ${res.status}: ${text}`, retryable);
      (err as { httpStatus?: number }).httpStatus = res.status;
      throw err;
    }

    const raw = await res.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw this.error("INVALID_RESPONSE", "response exceeds size cap", false);

    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw this.error("INVALID_RESPONSE", "response was not JSON", false); }

    const p = parsed as { choices?: Array<{ message?: { content?: unknown }, finish_reason?: unknown }>; usage?: unknown; model?: unknown };
    const choice = Array.isArray(p.choices) ? p.choices[0] : undefined;
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (!content) throw this.error("INVALID_RESPONSE", "no content in provider response", false);

    let structured: unknown | null = null;
    if (req.responseFormat === "json_object") {
      try { structured = JSON.parse(content); }
      catch { throw this.error("SCHEMA_INVALID", "structured output was not valid JSON", false); }
    }

    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const usageRaw = (p.usage ?? null) as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;

    return {
      requestId: req.requestId,
      providerId: this.providerId,
      model: typeof p.model === "string" ? p.model : cfg.model,
      content,
      structuredOutput: structured,
      usage: usageRaw ? {
        promptTokens: usageRaw.prompt_tokens,
        completionTokens: usageRaw.completion_tokens,
        totalTokens: usageRaw.total_tokens,
      } : null,
      latencyMs,
      finishReason,
      createdAt: Date.now(),
    };
  }

  private error(errorClass: AIProviderError["errorClass"], message: string, retryable: boolean): AIProviderError {
    return { errorClass, message: redactSecrets(message), retryable };
  }
}

export function openAICompatibleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AIProviderConfiguration {
  const providerId = env.NEXUS_AI_PROVIDER_ID ?? "openai-compatible";
  const model = env.NEXUS_AI_MODEL ?? "";
  const endpoint = env.NEXUS_AI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKeyEnvVar = env.NEXUS_AI_API_KEY_ENV ?? "OPENAI_API_KEY";
  const timeoutMs = Number(env.NEXUS_AI_TIMEOUT_MS ?? 60_000);
  const maxRetries = Number(env.NEXUS_AI_MAX_RETRIES ?? 2);
  const enabled = (env.NEXUS_AI_ENABLED ?? "false").toLowerCase() === "true" && !!model;
  const now = Date.now();
  return {
    providerId,
    providerType: "openai-compatible",
    model,
    endpoint,
    apiKeyEnvVar,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? Math.min(maxRetries, 5) : 2,
    enabled,
    structuredOutput: true,
    createdAt: now,
    updatedAt: now,
  };
}
