export interface ExecutionAdapterRequest {
  operation: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  metadata?: Record<string, any>;
}

export interface ExecutionAdapterResult {
  success: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  evidence?: Record<string, any>;
  externalId?: string;
}

export interface ExecutionAdapterContext {
  jobId?: string;
  attemptId?: string;
  cancellationSignal?: { cancelled: boolean };
}

export interface ExecutionAdapter {
  getId(): string;
  getType(): string;
  getCapabilities(): string[];
  validate(request: ExecutionAdapterRequest): { valid: boolean; errors: string[] };
  execute(request: ExecutionAdapterRequest, context?: ExecutionAdapterContext): Promise<ExecutionAdapterResult>;
  cancel(executionId?: string): Promise<void>;
  healthCheck(): Promise<boolean>;
}
