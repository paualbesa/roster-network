import { describe, expect, it } from "vitest";
import { DONATION_ADDRESSES } from "./donate";

describe("donation addresses", () => {
  it("match the owner's list exactly", () => {
    expect(Object.fromEntries(DONATION_ADDRESSES.map((d) => [d.id, d.address]))).toEqual({
      btc: "bc1q5gx3s7gth59cgchvsxhjtfmjlg83hzlx8msjpx",
      sol: "7BqWXo6BBweACr7VNFiJPKwTZ9nwsmKyUB89PEdbDeUX",
      eth: "0xcB821fa2e3569aA43d5Cd44Ab8f9373F05156218",
      bsc: "0xcB821fa2e3569aA43d5Cd44Ab8f9373F05156218",
      ltc: "ltc1qda7at4xdjjsqgmz8qc0pt86gxa3jgt30egjpsp",
    });
  });
});
