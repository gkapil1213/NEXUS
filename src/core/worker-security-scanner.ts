export interface SecurityScannerProvider {
  scan(assetId: string, category: string): Promise<{ status: 'SUCCESS' | 'UNAVAILABLE' | 'FAILED'; findings?: any[]; reason?: string }>;
}

export const unavailableSecurityScanner: SecurityScannerProvider = {
  async scan() { return { status: 'UNAVAILABLE', reason: 'scanner unavailable' }; },
};
