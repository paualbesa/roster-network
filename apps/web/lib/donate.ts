/** Donation addresses. Verified against the owner's list; covered by donate.test.ts. */
export const DONATION_ADDRESSES = [
  { id: "btc", network: "Bitcoin", symbol: "BTC", address: "bc1q5gx3s7gth59cgchvsxhjtfmjlg83hzlx8msjpx" },
  { id: "sol", network: "Solana", symbol: "SOL / SPL", address: "7BqWXo6BBweACr7VNFiJPKwTZ9nwsmKyUB89PEdbDeUX" },
  { id: "eth", network: "Ethereum", symbol: "ETH / ERC-20", address: "0xcB821fa2e3569aA43d5Cd44Ab8f9373F05156218" },
  { id: "bsc", network: "BNB Smart Chain", symbol: "BNB / BEP-20", address: "0xcB821fa2e3569aA43d5Cd44Ab8f9373F05156218" },
  { id: "ltc", network: "Litecoin", symbol: "LTC", address: "ltc1qda7at4xdjjsqgmz8qc0pt86gxa3jgt30egjpsp" },
] as const;

export const DONATION_NOTE = "Send only on the matching network. Funds sent on the wrong network are lost.";
