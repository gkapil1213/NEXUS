// src/core/ai-provider-contracts.ts
// Phase 216: provider-neutral AI execution contracts.
//
// The gateway (ai-provider-gateway.ts) depends only on these interfaces.
// Domain code (planning/architecture orchestrators) never sees a vendor
// SDK type. Provider-specific error shapes are normalized before they
// reach the domain.
//
// Secrets never appear in these objects. `apiKeyEnvVar` names an environment
// variable; the value is read only inside the provider adapter and never
// stored on the config object, logged, or emitted.

export type AIProviderErrorClass =
  | "NOT_CONFIGURED"
  | "AUTH"
  | "TIMEOUT"
  | "CONNECTION"
  | "RATE_LIMIT"
  | "SERVER"
  | "CLIENT"
  | "INVALID_RESPONSE"
  | "SCHEMA_INVALID"
  | "POLICY"
  | "UNKNOWN";

export interface AIProviderError {
  errorClass: AIProviderErrorClass;
  message: string;
  httpStatus?: number;
  retryable: boolean;
  detail?: string;
}

export interface AIProviderConfiguration {
  providerId: string;
  providerType: "openai-compatible";
  /** Logical model name; must not embed credentials. */
  model: string;
  /** Base URL, e.g. https://api.openai.com/v1 */
  endpoint: string;
  /** Name of the env var that holds the API key. Never the key itself. */
  apiKeyEnvVar: string;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  structuredOutput: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AIResponseFormat = "text" | "json_object";

export interface AIProviderRequest {
  requestId: string;
  providerId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseFormat: AIResponseFormat;
  timeoutMs: number;
  metadata?: Record<string, unknown>;
}

export interface AIProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AIProviderResponse {
  requestId: string;
  providerId: string;
  model: string;
  content: string;
  structuredOutput: unknown | null;
  usage: AIProviderUsage | null;
  latencyMs: number;
  finishReason: string | null;
  createdAt: number;
}

export interface AIProviderHealth {
  providerId: string;
  healthy: boolean;
  reason: string;
  checkedAt: number;
  latencyMs: number | null;
}

export type AIProviderCapabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "NOT_IMPLEMENTED";

export interface AIProviderCapability {
  providerId: string;
  status: AIProviderCapabilityStatus;
  reason: string;
  checkedAt: number;
  /** Optional probe latency in ms when a probe actually ran. */
  latencyMs?: number;
}

/** The provider adapter contract. Implementations perform a real network call. */
export interface AIProvider {
  readonly providerId: string;
  readonly configuration: AIProviderConfiguration;
  /** Cheap, bounded probe that determines whether the adapter can execute. */
  probe(): Promise<AIProviderCapability>;
  /** Real invocation. Must respect timeoutMs and throw AIProviderError-shaped errors. */
  invoke(req: AIProviderRequest): Promise<AIProviderResponse>;
}

export function isAIProviderError(e: unknown): e is AIProviderError {
  return !!e && typeof e === "object" && typeof (e as AIProviderError).errorClass === "string";
}
