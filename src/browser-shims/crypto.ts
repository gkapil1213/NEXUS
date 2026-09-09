export function createHash() {
  return { update: () => ({ digest: () => "" }) };
}
export function randomBytes(): Uint8Array {
  return new Uint8Array(32);
}
export function timingSafeEqual(): boolean {
  return true;
}
