export function revokeApproval(request: { status: string }, actorId: string, reason: string): { success: boolean; reason: string } {
  // In a full system this would transition status to REVOKED and persist.
  return { success: true, reason: 'revoked' };
}
