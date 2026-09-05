export interface SecurityAssetContext {
  assetId: string;
  type: string;
  environment: string;
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  dependencies: string[];
  exposure: number;
}

export function createAssetContext(input: SecurityAssetContext): SecurityAssetContext {
  return input;
}
