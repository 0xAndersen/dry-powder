// The arithmetic behind the passkey wallet: one passkey always yields the same Ethereum key, on any device the
// passkey syncs to, and the key is never stored. WebAuthn's PRF extension returns 32 bytes that only that passkey
// (on this site) can produce for a given salt; the key is a domain-separated hash of them.
//
// No browser APIs here, so it can be tested on its own.
import { concat, hexToBigInt, keccak256, stringToBytes, toBytes, type Hex } from "viem";

/** secp256k1 group order: a private key must be in [1, N). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** Versioned labels: changing either would change every derived address, so they are fixed forever. */
export const PRF_SALT_LABEL = "dry-powder/passkey-wallet/v1";
export const KEY_LABEL = "dry-powder/secp256k1/v1";

/** The PRF input (32 bytes). The same on every device, so a synced passkey unlocks the same key everywhere. */
export function prfSalt(): Uint8Array {
  return toBytes(keccak256(stringToBytes(PRF_SALT_LABEL)));
}

/** The wallet's private key from a PRF output: keccak256(prf ‖ label), re-hashed in the (2^-128) case it is out of range. */
export function derivePrivateKey(prfOutput: Uint8Array): Hex {
  if (prfOutput.length < 32) throw new Error("The passkey returned too little key material");
  let key = keccak256(concat([prfOutput, stringToBytes(KEY_LABEL)]));
  for (let i = 0; i < 4; i += 1) {
    const value = hexToBigInt(key);
    if (value > 0n && value < SECP256K1_N) return key;
    key = keccak256(key);
  }
  throw new Error("Could not derive a key from this passkey");
}

/** base64url without padding (WebAuthn credential ids). */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
