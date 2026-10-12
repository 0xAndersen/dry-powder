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
    name: "getUpdateFee",
    stateMutability: "view",
    inputs: [{ name: "updateData", type: "bytes[]" }],
    outputs: [{ name: "feeAmount", type: "uint256" }],
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
