// A wallet from a passkey: no extension, no seed phrase. The passkey's PRF output derives the key (passkey-core.ts);
// only the credential id and the address are remembered in this browser, and the key lives in memory until the page
// is closed or the user signs out. Every transaction and signature goes through the app's own approval step
// (PasskeyApprovals), because there is no wallet window to show it.
import { ChainNotConfiguredError, createConnector } from "wagmi";
import {
  SwitchChainError,
  UserRejectedRequestError,
  createPublicClient,
  getAddress,
  hexToBigInt,
  hexToNumber,
  http,
  isHex,
  numberToHex,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendRawTransaction } from "viem/actions";
import { derivePrivateKey, fromBase64Url, prfSalt, toBase64Url } from "./passkey-core";
import { arcFees, withGasHeadroom } from "./session";
import { createLocalStore } from "./storage";

// ───────────────────────────── Remembered passkeys ─────────────────────────────

export type PasskeyRecord = {
  /** WebAuthn credential id, base64url. */
  credentialId: string;
  address: Address;
  /** The site the passkey belongs to: a passkey only works where it was made. */
  rpId: string;
  createdAt: number;
  lastUsedAt: number;
};

export const passkeys = createLocalStore<PasskeyRecord[]>("dp:passkeys:v1", [], (stored) => {
  if (!Array.isArray(stored)) return null;
  return stored
    .filter(
      (p): p is PasskeyRecord =>
        !!p &&
        typeof (p as PasskeyRecord).credentialId === "string" &&
        typeof (p as PasskeyRecord).address === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test((p as PasskeyRecord).address) &&
        typeof (p as PasskeyRecord).rpId === "string",
    )
    .map((p) => ({ ...p, createdAt: Number(p.createdAt) || 0, lastUsedAt: Number(p.lastUsedAt) || 0 }))
    .slice(-10);
});

/** Passkeys made for this site, most recently used first. */
export function rememberedPasskeys(list: readonly PasskeyRecord[]): PasskeyRecord[] {
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  return list.filter((p) => p.rpId === host).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

// ───────────────────────────── Unlocked key (memory only) ─────────────────────────────

type Unlocked = { credentialId: string; address: Address; key: Hex };
let unlocked: Unlocked | null = null;
const unlockListeners = new Set<() => void>();

export function unlockedAddress(): Address | null {
  return unlocked?.address ?? null;
}

export function unlockedCredentialId(): string | null {
  return unlocked?.credentialId ?? null;
}

export function subscribeUnlocked(listener: () => void): () => void {
  unlockListeners.add(listener);
  return () => {
    unlockListeners.delete(listener);
  };
}

function setUnlocked(next: Unlocked | null): void {
  unlocked = next;
  for (const l of unlockListeners) l();
}

/** Forgets the key (sign out, or the page is going away). The passkey itself stays on the device. */
export function lockPasskeyWallet(): void {
  setUnlocked(null);
}

// ───────────────────────────── WebAuthn ─────────────────────────────

/** The passkey wallet is not unlocked (signed out, or the page was reloaded). */
export class PasskeyLockedError extends Error {
  constructor() {
    super("Sign in with your passkey first.");
    this.name = "ConnectorNotConnectedError";
  }
}

export class PasskeyUnsupportedError extends Error {
  constructor(message = "This passkey cannot derive a wallet key on this browser (it does not support the PRF extension). Use a browser wallet, or a passkey saved in iCloud Keychain, Google Password Manager or a recent security key.") {
    super(message);
    this.name = "PasskeyUnsupportedError";
  }
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } } };

/** What this browser says about passkeys: WebAuthn at all, and PRF when it can tell (null: unknown until tried). */
export async function passkeySupport(): Promise<{ webauthn: boolean; prf: boolean | null }> {
  if (typeof window === "undefined" || !("PublicKeyCredential" in window) || !navigator.credentials) return { webauthn: false, prf: false };
  const pkc = window.PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
  try {
    const caps = pkc.getClientCapabilities ? await pkc.getClientCapabilities() : null;
    const prf = caps && typeof caps["extension:prf"] === "boolean" ? caps["extension:prf"] : null;
    return { webauthn: true, prf };
  } catch {
    return { webauthn: true, prf: null };
  }
}

const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
const asBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function prfOutput(results: PrfResults): Uint8Array | null {
  const first = results.prf?.results?.first;
  if (!first) return null;
  return first instanceof Uint8Array ? first : new Uint8Array(first);
}

function remember(credentialId: string, output: Uint8Array): Unlocked {
  const key = derivePrivateKey(output);
  const address = privateKeyToAccount(key).address;
  const now = Date.now();
  const rpId = window.location.hostname;
  passkeys.set((list) => {
    const previous = list.find((p) => p.credentialId === credentialId);
    const rest = list.filter((p) => p.credentialId !== credentialId);
    return [...rest, { credentialId, address, rpId, createdAt: previous?.createdAt ?? now, lastUsedAt: now }];
  });
  const next = { credentialId, address, key };
  setUnlocked(next);
  return next;
}

/** Asks the passkey (Face ID, Touch ID, a security key) for its PRF output. `credentialId` narrows to one passkey. */
async function evaluate(credentialId?: string): Promise<{ id: string; output: Uint8Array }> {
  const salt = prfSalt();
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: asBuffer(randomBytes(32)),
      userVerification: "required",
      timeout: 120_000,
      allowCredentials: credentialId ? [{ type: "public-key", id: asBuffer(fromBase64Url(credentialId)) }] : [],
      extensions: { prf: { eval: { first: asBuffer(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was used.");
  const output = prfOutput(credential.getClientExtensionResults() as PrfResults);
  if (!output) throw new PasskeyUnsupportedError();
  return { id: toBase64Url(credential.rawId), output };
}

/**
 * Makes a new passkey for this site and derives its wallet. Browsers that can evaluate PRF while creating need one
 * confirmation; the others need a second one right after.
 */
export async function createPasskeyWallet(): Promise<{ address: Address; credentialId: string }> {
  const salt = prfSalt();
  const day = new Date().toISOString().slice(0, 10);
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Dry Powder" },
      user: { id: asBuffer(randomBytes(16)), name: `Dry Powder account (${day})`, displayName: "Dry Powder trading account" },
      challenge: asBuffer(randomBytes(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      timeout: 120_000,
      extensions: { prf: { eval: { first: asBuffer(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const id = toBase64Url(credential.rawId);
  const results = credential.getClientExtensionResults() as PrfResults;
  if (results.prf?.enabled === false) throw new PasskeyUnsupportedError();
  const output = prfOutput(results) ?? (await evaluate(id)).output;
  const { address } = remember(id, output);
  return { address, credentialId: id };
}

/** Unlocks the wallet of an existing passkey (the browser offers the passkeys it holds for this site). */
export async function unlockPasskeyWallet(credentialId?: string): Promise<{ address: Address; credentialId: string }> {
  const { id, output } = await evaluate(credentialId);
  const { address } = remember(id, output);
  return { address, credentialId: id };
}

/**
 * The private key, for a backup the user asked for. Asks the passkey again first, so an unattended screen cannot
 * reveal it. A passkey only works on the site it was made for: the backup is how funds follow a move elsewhere.
 */
export async function revealPasskeyKey(credentialId: string): Promise<Hex> {
  const { output } = await evaluate(credentialId);
  return derivePrivateKey(output);
}

// ───────────────────────────── In-app approvals ─────────────────────────────

export type ApprovalLine = { label: string; value: string };
export type ApprovalRequest = { id: number; kind: "transaction" | "signature"; title: string; lines: ApprovalLine[] };
type Pending = ApprovalRequest & { decide: (ok: boolean) => void };

let approvalId = 0;
let approvals: readonly Pending[] = [];
const approvalListeners = new Set<() => void>();
const emitApprovals = () => {
  for (const l of approvalListeners) l();
};

export const approvalStore = {
  get: (): readonly Pending[] => approvals,
  subscribe: (listener: () => void) => {
    approvalListeners.add(listener);
    return () => {
      approvalListeners.delete(listener);
    };
  },
  decide: (id: number, ok: boolean) => {
    const found = approvals.find((a) => a.id === id);
    approvals = approvals.filter((a) => a.id !== id);
    emitApprovals();
    found?.decide(ok);
  },
};

/** Shows the request in the app and resolves once approved; a rejection throws like a wallet's (code 4001). */
async function requestApproval(request: Omit<ApprovalRequest, "id">): Promise<void> {
  const ok = await new Promise<boolean>((resolve) => {
    approvalId += 1;
    approvals = [...approvals, { ...request, id: approvalId, decide: resolve }];
    emitApprovals();
  });
  if (!ok) throw new UserRejectedRequestError(new Error("Rejected in Dry Powder."));
}

// ───────────────────────────── Provider and connector ─────────────────────────────

export type TxPreview = { to: Address | null; data: Hex | undefined; value: bigint; gas: bigint; maxFeePerGas: bigint; chainId: number };
export type Describer = {
  transaction: (tx: TxPreview) => { title: string; lines: ApprovalLine[] };
  message: (text: string) => { title: string; lines: ApprovalLine[] };
  typedData: (data: { domain?: Record<string, unknown>; primaryType?: string; message?: unknown }) => { title: string; lines: ApprovalLine[] };
};

type RequestArgs = { method: string; params?: unknown };
export type PasskeyProvider = { request: (args: RequestArgs) => Promise<unknown> };

const UINT = /^u?int\d*$/;

/** eth_signTypedData_v4 carries integers as strings; viem's local signer wants bigints for (u)int fields. */
function reviveTypedValues(types: Record<string, readonly { name: string; type: string }[]>, type: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const array = /^(.*)\[\d*\]$/.exec(type);
  if (array) return Array.isArray(value) ? value.map((v) => reviveTypedValues(types, array[1]!, v)) : value;
  if (UINT.test(type)) return typeof value === "string" || typeof value === "number" ? BigInt(value) : value;
  const fields = types[type];
  if (!fields || typeof value !== "object") return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const f of fields) out[f.name] = reviveTypedValues(types, f.type, (value as Record<string, unknown>)[f.name]);
  return out;
}

/**
 * The passkey wallet as a wagmi connector. It never reconnects by itself on a page load (that would need a passkey
 * prompt without a click); the app's sign-in sheet unlocks first and then connects.
 */
export function passkeyConnector(options: { describe?: Describer } = {}) {
  return createConnector<PasskeyProvider>((config) => {
    const chain = config.chains[0];
    const transport = config.transports?.[chain.id] ?? http();
    const reads = createPublicClient({ chain, transport });
    let provider: PasskeyProvider | null = null;

    const current = (): Unlocked => {
      if (!unlocked) throw new PasskeyLockedError();
      return unlocked;
    };

    async function sendTransaction(raw: Record<string, unknown>): Promise<Hex> {
      const me = current();
      const from = typeof raw.from === "string" ? getAddress(raw.from) : me.address;
      if (from !== me.address) throw new Error("That transaction is for another account.");
      const to = typeof raw.to === "string" ? getAddress(raw.to) : null;
      const data = typeof raw.data === "string" ? (raw.data as Hex) : typeof raw.input === "string" ? (raw.input as Hex) : undefined;
      const value = typeof raw.value === "string" && isHex(raw.value) ? hexToBigInt(raw.value) : 0n;
      const gas =
        typeof raw.gas === "string" && isHex(raw.gas)
          ? hexToBigInt(raw.gas)
          : withGasHeadroom(await reads.estimateGas({ account: from, to: to ?? undefined, data, value }));
      const fees =
        typeof raw.maxFeePerGas === "string" && isHex(raw.maxFeePerGas)
          ? {
              maxFeePerGas: hexToBigInt(raw.maxFeePerGas),
              maxPriorityFeePerGas: typeof raw.maxPriorityFeePerGas === "string" && isHex(raw.maxPriorityFeePerGas) ? hexToBigInt(raw.maxPriorityFeePerGas) : 1_000_000_000n,
            }
          : await arcFees(reads);
      const nonce = typeof raw.nonce === "string" && isHex(raw.nonce) ? hexToNumber(raw.nonce) : await reads.getTransactionCount({ address: from, blockTag: "pending" });
      const preview: TxPreview = { to, data, value, gas, maxFeePerGas: fees.maxFeePerGas, chainId: chain.id };
      await requestApproval({ kind: "transaction", ...(options.describe?.transaction(preview) ?? { title: "Send a transaction", lines: [{ label: "To", value: to ?? "new contract" }] }) });
      const signer = privateKeyToAccount(current().key);
      const serializedTransaction = await signer.signTransaction({
        type: "eip1559",
        chainId: chain.id,
        to,
        data,
        value,
        gas,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      return sendRawTransaction(reads, { serializedTransaction });
    }

    async function personalSign(params: readonly unknown[]): Promise<Hex> {
      const [message] = params as [Hex];
      let text: string = message;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytesSafe(message));
      } catch {
        // Not text: show the bytes.
      }
      await requestApproval({ kind: "signature", ...(options.describe?.message(text) ?? { title: "Sign a message", lines: [{ label: "Message", value: text.slice(0, 280) }] }) });
      return privateKeyToAccount(current().key).signMessage({ message: { raw: message } });
    }

    async function signTypedData(params: readonly unknown[]): Promise<Hex> {
      const [, json] = params as [Address, string];
      const parsed = (typeof json === "string" ? JSON.parse(json) : json) as {
        domain?: Record<string, unknown>;
        types: Record<string, { name: string; type: string }[]>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const { EIP712Domain: _domainType, ...types } = parsed.types;
      void _domainType;
      const domain = parsed.domain ? (reviveTypedValues({ D: parsed.types.EIP712Domain ?? [] }, "D", parsed.domain) as Record<string, unknown>) : undefined;
      const message = reviveTypedValues(types, parsed.primaryType, parsed.message) as Record<string, unknown>;
      await requestApproval({ kind: "signature", ...(options.describe?.typedData({ domain, primaryType: parsed.primaryType, message }) ?? { title: "Sign typed data", lines: [{ label: "Type", value: parsed.primaryType }] }) });
      return privateKeyToAccount(current().key).signTypedData({ domain, types, primaryType: parsed.primaryType, message } as unknown as TypedDataDefinition);
    }

    const makeProvider = (): PasskeyProvider => ({
      async request({ method, params }: RequestArgs) {
        const list = (Array.isArray(params) ? params : []) as unknown[];
        switch (method) {
          case "eth_accounts":
            return unlocked ? [unlocked.address] : [];
          case "eth_requestAccounts":
            return [current().address];
          case "eth_chainId":
            return numberToHex(chain.id);
          case "wallet_switchEthereumChain": {
            const target = Number((list[0] as { chainId?: string } | undefined)?.chainId ?? NaN);
            if (target !== chain.id) throw new SwitchChainError(new ChainNotConfiguredError());
            return null;
          }
          case "wallet_addEthereumChain":
            return null;
          case "eth_sendTransaction":
            return sendTransaction((list[0] ?? {}) as Record<string, unknown>);
          case "personal_sign":
            return personalSign(list);
          case "eth_signTypedData_v4":
            return signTypedData(list);
          case "eth_sign":
          case "eth_signTransaction":
            throw new Error(`${method} is not offered by the passkey wallet.`);
          default:
            return reads.request({ method, params } as never);
        }
      },
    });

    return {
      id: "passkey",
      name: "Passkey",
      type: "passkey",
      async connect(parameters?: { chainId?: number; isReconnecting?: boolean; withCapabilities?: boolean }) {
        if (parameters?.isReconnecting && !unlocked) throw new PasskeyLockedError();
        let me: Unlocked;
        if (unlocked) me = unlocked;
        else {
          await unlockPasskeyWallet();
          me = current();
        }
        if (parameters?.chainId && parameters.chainId !== chain.id) throw new SwitchChainError(new ChainNotConfiguredError());
        const accounts = [me.address] as const;
        return {
          accounts: (parameters?.withCapabilities ? accounts.map((address) => ({ address, capabilities: {} })) : accounts) as never,
          chainId: chain.id,
        };
      },
      async disconnect() {
        lockPasskeyWallet();
      },
      async getAccounts() {
        return [current().address];
      },
      async getChainId() {
        return chain.id;
      },
      async getProvider() {
        provider ??= makeProvider();
        return provider;
      },
      async isAuthorized() {
        return unlocked !== null;
      },
      async switchChain({ chainId }: { chainId: number }) {
        if (chainId !== chain.id) throw new SwitchChainError(new ChainNotConfiguredError());
        return chain;
      },
      onAccountsChanged(accounts: string[]) {
        if (accounts.length === 0) this.onDisconnect();
        else config.emitter.emit("change", { accounts: accounts.map((a) => getAddress(a)) });
      },
      onChainChanged() {
        // One chain only.
      },
      onDisconnect() {
        lockPasskeyWallet();
        config.emitter.emit("disconnect");
      },
    };
  });
}

function hexToBytesSafe(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The connector's id, for finding it in `useConnect().connectors`. */
export const PASSKEY_CONNECTOR_ID = "passkey";
