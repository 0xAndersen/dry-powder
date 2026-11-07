import type { Hex } from "viem";

/** Keeper-executed orders placed in this session, followed until they fill or disappear. */
export type TrackedOrder = {
  orderId: bigint;
  marketId: Hex;
  symbol: string;
  action: "open" | "close" | "limit";
  isLong: boolean;
  placedAt: number;
  status: "resting" | "filled" | "cancelled" | "gone";
  /** 18-decimal execution price once filled. */
  fillPrice?: bigint;
  settledAt?: number;
};

let orders: TrackedOrder[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

const EMPTY: TrackedOrder[] = [];

export const orderTracker = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  get: (): TrackedOrder[] => orders,
  getServer: (): TrackedOrder[] => EMPTY,
  track(order: Omit<TrackedOrder, "status" | "placedAt">): void {
    orders = [...orders.filter((o) => o.orderId !== order.orderId).slice(-11), { ...order, status: "resting", placedAt: Date.now() }];
    emit();
  },
  resolve(orderId: bigint, status: TrackedOrder["status"], fillPrice?: bigint): void {
    let changed = false;
    orders = orders.map((o) => {
      if (o.orderId !== orderId || o.status !== "resting") return o;
      changed = true;
      return { ...o, status, fillPrice, settledAt: Date.now() };
    });
    if (changed) emit();
  },
  clearSettled(): void {
    orders = orders.filter((o) => o.status === "resting");
    emit();
  },
};
