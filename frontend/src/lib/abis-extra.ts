/** Minimal ABIs for contracts that are not part of the generated protocol ABIs. */

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  { type: "error", name: "ERC20InsufficientAllowance", inputs: [
      { name: "spender", type: "address" },
      { name: "allowance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ] },
  { type: "error", name: "ERC20InsufficientBalance", inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ] },
] as const;

export const pythAbi = [
  {
    type: "function",
    name: "getPriceUnsafe",
    stateMutability: "view",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [
      {
        name: "price",
        type: "tuple",
        components: [
          { name: "price", type: "int64" },
          { name: "conf", type: "uint64" },
          { name: "expo", type: "int32" },
          { name: "publishTime", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getUpdateFee",
    stateMutability: "view",
    inputs: [{ name: "updateData", type: "bytes[]" }],
    outputs: [{ name: "feeAmount", type: "uint256" }],
  },
] as const;

/**
 * Engine events added in v3.1 (adding to a position, partial closes, margin top-ups). Read alongside the generated
 * engine ABI so history and analytics are right once v3.1 is deployed; an older engine never emits them.
 */
export const engineV31EventsAbi = [
  {
    type: "event",
    name: "PositionIncreased",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "priceId", type: "bytes32", indexed: true },
      { name: "isLong", type: "bool", indexed: false },
      { name: "addedMargin", type: "uint256", indexed: false },
      { name: "addedSize", type: "uint256", indexed: false },
      { name: "price", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "newMargin", type: "uint256", indexed: false },
      { name: "newSize", type: "uint256", indexed: false },
      { name: "newEntryPrice", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PositionDecreased",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "priceId", type: "bytes32", indexed: true },
      { name: "exitPrice", type: "uint256", indexed: false },
      { name: "closedSize", type: "uint256", indexed: false },
      { name: "releasedMargin", type: "uint256", indexed: false },
      { name: "pnl", type: "int256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "MarginAdded",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "newMargin", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;

/** Custom errors Pyth can raise while the engine forwards a price update. */
export const pythErrorsAbi = [
  { type: "error", name: "InsufficientFee", inputs: [] },
  { type: "error", name: "InvalidUpdateData", inputs: [] },
  { type: "error", name: "InvalidUpdateDataSource", inputs: [] },
  { type: "error", name: "InvalidWormholeVaa", inputs: [] },
  { type: "error", name: "InvalidGovernanceMessage", inputs: [] },
  { type: "error", name: "NoFreshUpdate", inputs: [] },
  { type: "error", name: "PriceFeedNotFound", inputs: [] },
  { type: "error", name: "StalePrice", inputs: [] },
] as const;
