export type NetworkPolicyMode =
  | "NETWORK_DISABLED"
  | "NETWORK_ALLOWLIST"
  | "NETWORK_RESTRICTED"
  | "NETWORK_FULL";

export interface NetworkPolicy {
  mode: NetworkPolicyMode;
  allowedHosts?: string[];
}

export class WorkerNetworkPolicy {
  constructor(private policy: NetworkPolicy) {}

  isAllowed(host: string): boolean {
    switch (this.policy.mode) {
      case "NETWORK_DISABLED":
        return false;
      case "NETWORK_ALLOWLIST":
        return this.policy.allowedHosts?.includes(host) ?? false;
      case "NETWORK_RESTRICTED":
        // conservative: deny by default unless host is in allowlist if provided
        return this.policy.allowedHosts?.includes(host) ?? false;
      case "NETWORK_FULL":
        return true;
      default:
        return false;
    }
  }
}
