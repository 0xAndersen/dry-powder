// Pure parts of onboarding: CCTP fee planning and status, and the passkey key derivation.
// Run from frontend/ with: node --test test/onboarding.test.mjs   (Node 22.18+ strips the TypeScript types on import)
import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { CCTP, CCTP_SOURCES, FORWARD_PATIENCE_MS, addressToBytes32, bpsToHundredths, nextStatus, planBurn, readIrisMessage, sourceByChainId } from "../src/lib/cctp-core.ts";
import { derivePrivateKey, fromBase64Url, prfSalt, toBase64Url } from "../src/lib/passkey-core.ts";

const FEES = [
  { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 40000, med: 57543, high: 90000 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 40000, med: 57543, high: 90000 } },
];

test("addresses become left-padded 32-byte words", () => {
  assert.equal(addressToBytes32("0x00000000000000000000000000000000000000AB"), `0x${"0".repeat(62)}ab`);
  assert.equal(addressToBytes32("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238").length, 66);
  assert.throws(() => addressToBytes32("0x1234"));
});

test("fees in fractional basis points are read exactly", () => {
  assert.equal(bpsToHundredths("1.3"), 130n);
  assert.equal(bpsToHundredths(1.25), 125n);
  assert.equal(bpsToHundredths("14"), 1400n);
  assert.equal(bpsToHundredths(0), 0n);
  assert.throws(() => bpsToHundredths("-1"));
});

test("a fast forwarded burn covers the forwarding fee and the protocol fee with a cushion", () => {
  const plan = planBurn(10_000_000n, FEES, { fast: true, forward: true });
  assert.equal(plan.threshold, 1000);
  assert.equal(plan.protocolFee, 1_300n); // 10 USDC x 1.3 bp
  assert.equal(plan.forwardFee, 57_543n);
  assert.equal(plan.maxFee, 57_543n + 1_560n); // protocol fee + 20%
  assert.equal(plan.burn, 10_000_000n + plan.maxFee);
  assert.equal(plan.receiveAtLeast, 10_000_000n);
});

test("standard and unforwarded burns", () => {
  const standard = planBurn(10_000_000n, FEES, { fast: false, forward: true });
  assert.equal(standard.threshold, 2000);
  assert.equal(standard.maxFee, 57_543n);
  const unforwarded = planBurn(10_000_000n, FEES, { fast: true, forward: false });
  assert.equal(unforwarded.forwardFee, 0n);
  assert.equal(unforwarded.maxFee, 1_560n);
  const free = planBurn(10_000_000n, FEES, { fast: false, forward: false });
  assert.equal(free.maxFee, 0n);
  assert.equal(free.burn, 10_000_000n);
});

test("bad plans are refused", () => {
  assert.throws(() => planBurn(0n, FEES, { fast: true, forward: true }), /greater than zero/);
  assert.throws(() => planBurn(1n, [FEES[1]], { fast: true, forward: true }), /Fast/);
  assert.throws(() => planBurn(1n, [{ finalityThreshold: 1000, minimumFee: 1 }], { fast: true, forward: true }), /forwarding fee/);
});

test("Iris messages are read defensively", () => {
  assert.equal(readIrisMessage(null), null);
  assert.equal(readIrisMessage({ messages: [] }), null);
  const m = readIrisMessage({ messages: [{ status: "complete", message: "0xabcd", attestation: "0x1234", forwardTxHash: null, forwardState: "PENDING" }] });
  assert.deepEqual(m, { status: "complete", message: "0xabcd", attestation: "0x1234", forwardTxHash: null, forwardState: "PENDING", delayReason: null });
  assert.equal(readIrisMessage({ messages: [{ status: "pending_confirmations", message: "0x", attestation: "PENDING" }] })?.attestation, null);
});

test("a transfer moves from attesting to forwarding to done, or to claimable", () => {
  const now = 1_800_000_000_000;
  const t = { burnTx: `0x${"1".repeat(64)}`, sourceChainId: 84532, sourceDomain: 6, amount: "10000000", maxFee: "59103", recipient: "0x00000000000000000000000000000000000000AB", forward: true, fast: true, createdAt: now, status: "attesting" };
  assert.equal(nextStatus(t, null, now).status, "attesting");
  assert.equal(nextStatus(t, { status: "pending_confirmations", message: null, attestation: null, forwardTxHash: null, forwardState: null, delayReason: "insufficient_fee" }, now).note, "Attestation delayed (insufficient_fee)");
  const attested = { status: "complete", message: "0xabcd", attestation: "0x1234", forwardTxHash: null, forwardState: null, delayReason: null };
  assert.equal(nextStatus(t, attested, now + 1_000).status, "forwarding");
  assert.equal(nextStatus(t, attested, now + FORWARD_PATIENCE_MS + 1).status, "claimable");
  assert.equal(nextStatus(t, { ...attested, forwardState: "FAILED" }, now + 1_000).status, "claimable");
  const done = nextStatus(t, { ...attested, forwardTxHash: `0x${"2".repeat(64)}` }, now + 1_000);
  assert.equal(done.status, "done");
  assert.equal(done.mintTx, `0x${"2".repeat(64)}`);
  assert.equal(nextStatus({ ...t, forward: false }, attested, now).status, "claimable");
  assert.equal(nextStatus({ ...t, status: "done" }, null, now).status, "done");
});

test("every source chain is a known testnet with a USDC address, and Arc is domain 26", () => {
  assert.equal(CCTP.arcDomain, 26);
  assert.ok(CCTP_SOURCES.length >= 8);
  for (const s of CCTP_SOURCES) {
    assert.match(s.usdc, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(sourceByChainId(s.chain.id), s);
    assert.ok(s.chain.testnet, `${s.chain.name} is a testnet`);
  }
  assert.equal(new Set(CCTP_SOURCES.map((s) => s.domain)).size, CCTP_SOURCES.length);
});

test("a passkey's PRF output always gives the same valid key, and different outputs give different keys", () => {
  const a = new Uint8Array(32).fill(7);
  const b = new Uint8Array(32).fill(8);
  const ka = derivePrivateKey(a);
  assert.equal(derivePrivateKey(a), ka);
  assert.notEqual(derivePrivateKey(b), ka);
  assert.match(privateKeyToAccount(ka).address, /^0x[0-9a-fA-F]{40}$/);
  assert.throws(() => derivePrivateKey(new Uint8Array(16)), /too little/);
});

test("the salt and the derivation are pinned (changing either would move every passkey account)", () => {
  const salt = prfSalt();
  assert.equal(salt.length, 32);
  assert.equal(Buffer.from(salt).toString("hex"), "0492ddcff23bdfe10b399320760480e8a403e0b92735e6174d3b852f85ff8a5a");
  assert.equal(privateKeyToAccount(derivePrivateKey(new Uint8Array(32).fill(7))).address, "0x3530981d9EA6E60e391AAEeE9c4898556dAfBF94");
});

test("credential ids round-trip through base64url", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const text = toBase64Url(bytes);
  assert.doesNotMatch(text, /[+/=]/);
  assert.deepEqual(fromBase64Url(text), bytes);
});
