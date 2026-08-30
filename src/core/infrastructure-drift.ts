import { TerraformService } from "./terraform-service";

export interface DriftResult {
  status: "NO_DRIFT" | "DRIFT_DETECTED" | "BLOCKED";
  details?: string;
}

export class InfrastructureDriftService {
  constructor(private terraform: TerraformService) {}

  async detect(workspaceDir: string): Promise<DriftResult> {
    if (!(await this.terraform.isAvailable())) {
      return { status: "BLOCKED", details: "Terraform not installed" };
    }
    // In a real implementation, run `terraform plan -detailed-exitcode` and compare.
    // Here we simulate because no AWS/remote state available.
    // For safety, return BLOCKED if no real detection can run.
    return { status: "BLOCKED", details: "Terraform drift detection requires real AWS/remote state" };
  }
}