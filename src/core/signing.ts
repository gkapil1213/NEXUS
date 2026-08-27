import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "crypto";

export interface SigningKeyPair {
  privateKey: string;
  publicKey: string;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  return { privateKey, publicKey };
}

export function signArtifactDigest(
  digest: string,
  privateKeyPem: string,
): string {
  const privateKey = createPrivateKey(privateKeyPem);
  const data = Buffer.from(digest, "utf8");
  const signature = cryptoSign(null, data, privateKey);
  return signature.toString("base64");
}

export function verifyArtifactSignature(
  digest: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const data = Buffer.from(digest, "utf8");
    return cryptoVerify(
      null,
      data,
      publicKey,
      Buffer.from(signatureB64, "base64"),
    );
  } catch {
    return false;
  }
}