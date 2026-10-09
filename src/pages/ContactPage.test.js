import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ContactPage from "./ContactPage";
import { WishlistProvider } from "../context/WishlistContext";
import { submitEnquiryToMongo } from "../lib/enquiryApi";

// The two side-effect destinations this page fires besides /api/enquire —
// stubbed so the test asserts on what the form SENDS, not on Mongo or the
// Meta pixel actually being reachable.
jest.mock("../lib/enquiryApi", () => ({ submitEnquiryToMongo: jest.fn() }));
jest.mock("../lib/formConversionPixel", () => ({ trackFormSubmission: jest.fn() }));

function renderPage() {
  return render(
    <MemoryRouter>
      {/* The shared navbar this page renders reads the wishlist context. */}
      <WishlistProvider>
        <ContactPage />
      </WishlistProvider>
    </MemoryRouter>
  );
}

function enquireCall() {
  return global.fetch.mock.calls.find(([url]) => url === "/api/enquire");
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, emailSent: true }),
  });
});

test("blocks a number that is too short for the selected country", async () => {
  renderPage();

  fireEvent.change(screen.getByLabelText(/Full Name/i), { target: { value: "Aisha Khan" } });
  fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "aisha@example.com" } });
  fireEvent.change(screen.getByLabelText(/Phone \/ WhatsApp/i), { target: { value: "98765" } });
  fireEvent.click(screen.getByRole("button", { name: /Send Message/i }));

  expect(await screen.findByText("India numbers are 10 digits.")).toBeInTheDocument();
  expect(enquireCall()).toBeUndefined(); // nothing was submitted
});

test("sends the email address and the dial-code-prefixed number to every destination", async () => {
  renderPage();

  fireEvent.change(screen.getByLabelText(/Full Name/i), { target: { value: "Aisha Khan" } });
  fireEvent.change(screen.getByLabelText(/Email/i), { target: { value: "aisha@example.com" } });
  fireEvent.change(screen.getByLabelText(/Phone \/ WhatsApp/i), { target: { value: "9876543210" } });
  fireEvent.click(screen.getByRole("button", { name: /Send Message/i }));

  await waitFor(() => expect(enquireCall()).toBeDefined());

  const payload = JSON.parse(enquireCall()[1].body);
  expect(payload.studentEmail).toBe("aisha@example.com");
  expect(payload.phoneNumber).toBe("+91 9876543210");

  await waitFor(() => expect(submitEnquiryToMongo).toHaveBeenCalled());
  expect(submitEnquiryToMongo.mock.calls[0][0].contact).toMatchObject({
    email: "aisha@example.com",
    phone: "+91 9876543210",
  });
});
