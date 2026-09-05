export interface GovernanceFreeze {
  freezeId: string;
  scope: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

export function createGovernanceFreeze(scope: string, reason: string, createdBy: string, expiresAt: string): GovernanceFreeze {
  return { freezeId: `freeze-${Date.now()}`, scope, reason, createdBy, createdAt: new Date().toISOString(), expiresAt };
}

export function isFreezeActive(freeze: GovernanceFreeze): boolean {
  return new Date(freeze.expiresAt) > new Date();
}
