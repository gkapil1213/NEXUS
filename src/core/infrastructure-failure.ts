export type InfrastructureFailureType =
  | "DEPLOYMENT_FAILURE"
  | "HEALTH_FAILURE"
  | "NETWORK_FAILURE"
  | "RESOURCE_FAILURE"
  | "AUTHENTICATION_FAILURE"
  | "CONFIGURATION_FAILURE"
  | "TERRAFORM_FAILURE"
  | "AWS_API_FAILURE"
  | "TIMEOUT"
  | "UNKNOWN";

export interface InfrastructureFailure {
  id: string;
  execution_id: string;
  operation: string;
  type: InfrastructureFailureType;
  resource?: string;
  provider?: string;
  plan_digest?: string;
  stdout?: string;
  stderr?: string;
  previous_state: string;
  current_state: string;
  timestamp: string;
  evidence_ref?: string;
}

export class InfrastructureFailureDetector {
  classify(err: Error, context: { operation: string; resource?: string; provider?: string }): InfrastructureFailureType {
    const msg = err.message.toLowerCase();
    if (msg.includes("timeout")) return "TIMEOUT";
    if (msg.includes("auth") || msg.includes("credential")) return "AUTHENTICATION_FAILURE";
    if (msg.includes("network") || msg.includes("dns")) return "NETWORK_FAILURE";
    if (msg.includes("terraform")) return "TERRAFORM_FAILURE";
    if (msg.includes("aws") || msg.includes("ecr") || msg.includes("ecs")) return "AWS_API_FAILURE";
    if (msg.includes("health")) return "HEALTH_FAILURE";
    if (msg.includes("config")) return "CONFIGURATION_FAILURE";
    if (msg.includes("resource")) return "RESOURCE_FAILURE";
    if (msg.includes("deploy")) return "DEPLOYMENT_FAILURE";
    return "UNKNOWN";
  }

  createFailure(input: Omit<InfrastructureFailure, "id" | "timestamp">): InfrastructureFailure {
    return {
      id: `fail_${Date.now().toString(36)}`,
      timestamp: new Date().toISOString(),
      ...input,
    };
  }
}