import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import HeroInventoryCards from "./HeroInventoryCards";
import { getInventoryStats } from "../../services/amberApi";

// Real component + real useInventoryStats hook; only the network-facing
// service is stubbed, so the loading / ready / failure state machine is
// exercised exactly as it runs on the homepage.
jest.mock("../../services/amberApi", () => ({ getInventoryStats: jest.fn() }));

// Cards render in a fixed order: Total Inventory, Sold Out, Remaining.
const cards = () => screen.getAllByRole("listitem");

beforeEach(() => {
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

test("renders all three cards with the exact counts from one backend response", async () => {
  getInventoryStats.mockResolvedValue({ ready: true, total: 4281, soldOut: 1060, remaining: 3221, stale: false });
  const { rerender } = render(<HeroInventoryCards />);

  expect(cards()).toHaveLength(3);
  await waitFor(() => expect(cards().map((c) => c.textContent)).toEqual([
    "4,281Total Inventory",
    "1,060Sold Out",
    "3,221Remaining",
  ]), { timeout: 3000 });

  // One request covers all three cards, and rerenders never refetch.
  rerender(<HeroInventoryCards />);
  rerender(<HeroInventoryCards />);
  expect(getInventoryStats).toHaveBeenCalledTimes(1);
});

test("shows a neutral skeleton (not zeros) while the stats are loading", () => {
  getInventoryStats.mockReturnValue(new Promise(() => {}));
  render(<HeroInventoryCards />);

  expect(screen.getByRole("list", { name: "Live IVYHUTS inventory" })).toHaveAttribute("aria-busy", "true");
  // Only the label is present — the value slot is an aria-hidden skeleton.
  expect(cards().map((c) => c.textContent)).toEqual(["Total Inventory", "Sold Out", "Remaining"]);
});

test("on backend failure shows a neutral placeholder, never fabricated zeros", async () => {
  jest.useFakeTimers();
  getInventoryStats.mockRejectedValue(new Error("Inventory stats request failed (503)"));
  render(<HeroInventoryCards />);

  // useInventoryStats' fast retry phase (3 attempts, 1.5s apart) must finish
  // before it reports an error.
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { jest.advanceTimersByTime(1500); });
  }

  expect(cards().map((c) => c.textContent)).toEqual([
    "—UnavailableTotal Inventory",
    "—UnavailableSold Out",
    "—UnavailableRemaining",
  ]);
  expect(screen.getByRole("list", { name: "Live IVYHUTS inventory" })).not.toHaveAttribute("aria-busy");
});

test("a `ready:false` (aggregate still building) response is treated as loading, not as zero", async () => {
  getInventoryStats.mockResolvedValue({ ready: false });
  render(<HeroInventoryCards />);
  await waitFor(() => expect(getInventoryStats).toHaveBeenCalledTimes(1));

  expect(screen.getByRole("list", { name: "Live IVYHUTS inventory" })).toHaveAttribute("aria-busy", "true");
  expect(cards().map((c) => c.textContent)).toEqual(["Total Inventory", "Sold Out", "Remaining"]);
});
