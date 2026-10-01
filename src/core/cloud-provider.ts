import type {
  CloudIdentity,
  CloudOperationResult,
  CloudProviderName,
  CapabilityReport,
} from "./cloud-types";

export abstract class CloudProvider {
  abstract readonly name: CloudProviderName;

  abstract getIdentity(): Promise<CloudOperationResult<CloudIdentity>>;
  abstract getRegion(): Promise<CloudOperationResult<string>>;
  abstract listRepositories(): Promise<CloudOperationResult>;
  abstract getRepository(name: string): Promise<CloudOperationResult>;
  abstract listClusters(): Promise<CloudOperationResult>;
  abstract listServices(cluster: string): Promise<CloudOperationResult>;
  abstract listLoadBalancers(): Promise<CloudOperationResult>;
  abstract listLogGroups(): Promise<CloudOperationResult>;
  abstract getSecretMetadata(secretId: string): Promise<CloudOperationResult>;
  /** Phase 229: provider-neutral capability declaration. */
  abstract capabilities(): Promise<CapabilityReport>;
}