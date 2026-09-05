export type ArtifactPromotionState = 'BUILD' | 'TESTED' | 'SECURITY_VERIFIED' | 'GOVERNANCE_APPROVED' | 'STAGED' | 'RELEASE_CANDIDATE' | 'PRODUCTION_ELIGIBLE' | 'REVOKED';

export interface ArtifactPromotion {
  artifactId: string;
  state: ArtifactPromotionState;
  fingerprint: string;
  updatedAt: string;
  idempotencyKey: string;
}

export function promoteArtifact(
  artifactId: string,
  currentState: ArtifactPromotionState,
  nextState: ArtifactPromotionState,
  fingerprint: string
): { promotion?: ArtifactPromotion; success: boolean; reason: string } {
  const order: ArtifactPromotionState[] = ['BUILD', 'TESTED', 'SECURITY_VERIFIED', 'GOVERNANCE_APPROVED', 'STAGED', 'RELEASE_CANDIDATE', 'PRODUCTION_ELIGIBLE'];
  const idx = order.indexOf(currentState);
  const nextIdx = order.indexOf(nextState);
  if (nextState === 'REVOKED') {
    return { promotion: { artifactId, state: 'REVOKED', fingerprint, updatedAt: new Date().toISOString(), idempotencyKey: `${artifactId}:REVOKED` }, success: true, reason: 'revoked' };
  }
  if (nextIdx <= idx) return { success: false, reason: 'invalid promotion order' };
  return { promotion: { artifactId, state: nextState, fingerprint, updatedAt: new Date().toISOString(), idempotencyKey: `${artifactId}:${nextState}` }, success: true, reason: 'promoted' };
}
