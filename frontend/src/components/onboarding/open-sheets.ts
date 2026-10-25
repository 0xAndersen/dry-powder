// Any screen can open the sign-in or funds sheets (they live with the wallet button in the header) without
// importing it: dispatch an event, the header listens.

export type FundsTab = "add" | "bridge" | "gateway" | "withdraw";

export const SIGN_IN_EVENT = "dp:open-sign-in";
export const FUNDS_EVENT = "dp:open-funds";

/** Opens the sign-in sheet (passkey or browser wallet, then gas and instant trading). */
export function openSignIn(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SIGN_IN_EVENT));
}

/** Opens the funds sheet on a tab: practice funds and gas, USDC from another chain, Gateway, or withdraw. */
export function openFunds(tab: FundsTab = "add"): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<FundsTab>(FUNDS_EVENT, { detail: tab }));
}
