import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  KeyObject,
} from "crypto";

export interface SigningKeyPair {
  privateKey: string;
  publicKey: string;
}

/**
 * Generate a real Ed25519 key pair for artifact signing.
 * Private key is returned in PEM format (PKCS#8).
 */
export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return { privateKey, publicKey };
}

/**
 * Sign an artifact digest using the private key.
 * Returns the signature as base64.
 */
export function signArtifactDigest(
  digest: string,
  privateKeyPem: string,
): string {
  const sign = cryptoSign("sha256", Buffer.from(digest, "hex"), {
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  } as any);
  return sign.toString("base64");
}

/**
 * Verify a signature against the artifact digest and public key.
 * Returns true if signature is valid.
 */
export function verifyArtifactSignature(
  digest: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const sigBuffer = Buffer.from(signatureB64, "base64");
    return cryptoVerify(
      "sha256",
      Buffer.from(digest, "hex"),
      {
        key: publicKeyPem,
        format: "pem",
        type: "spki",
      } as any,
      sigBuffer,
    );
  } catch {
    return false;
  }
}