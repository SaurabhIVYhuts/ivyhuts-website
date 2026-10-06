import React, { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import PhoneField from "./PhoneField";
import { findCountry, formatFullNumber, validateNationalNumber } from "../../data/countryDialCodes";

// A thin stand-in for how both real forms use this control: parent owns the
// country + national digits.
function Harness() {
  const [country, setCountry] = useState(() => findCountry("IN"));
  const [value, setValue] = useState("");
  return (
    <>
      <PhoneField country={country} onCountryChange={setCountry} value={value} onChange={setValue} inputId="t-phone" />
      <output data-testid="submitted">{formatFullNumber(country, value)}</output>
    </>
  );
}

describe("PhoneField", () => {
  test("caps typing at the selected country's digit limit", () => {
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "" }) || screen.getByPlaceholderText("10-digit number");
    fireEvent.change(input, { target: { value: "98765432109999" } });
    expect(input.value).toBe("9876543210"); // India: 10
  });

  test("strips anything that isn't a digit", () => {
    render(<Harness />);
    const input = screen.getByPlaceholderText("10-digit number");
    fireEvent.change(input, { target: { value: "+91 98765-43210" } });
    expect(input.value).toBe("9198765432"); // the + and separators never reach the value
  });

  test("switching country re-caps an over-long number and changes the dial code", () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText("10-digit number"), { target: { value: "9876543210" } });

    fireEvent.click(screen.getByRole("button", { name: /Country code/ }));
    fireEvent.change(screen.getByLabelText("Search for a country"), { target: { value: "ireland" } });
    fireEvent.click(screen.getByRole("option", { name: /Ireland/ }));

    // Ireland maxes at 9 digits, so the 10-digit number is truncated.
    expect(screen.getByTestId("submitted").textContent).toBe("+353 987654321");
  });

  test("searching by dial code finds the country", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Country code/ }));
    fireEvent.change(screen.getByLabelText("Search for a country"), { target: { value: "972" } });
    expect(screen.getByRole("option", { name: /Israel/ })).toBeInTheDocument();
  });
});

describe("validateNationalNumber", () => {
  test("names the expected length for a fixed-length country", () => {
    expect(validateNationalNumber(findCountry("IN"), "98765")).toBe("India numbers are 10 digits.");
    expect(validateNationalNumber(findCountry("IN"), "9876543210")).toBeNull();
  });

  test("accepts the whole range where a country has one", () => {
    const germany = findCountry("DE");
    expect(validateNationalNumber(germany, "1512345678")).toBeNull();
    expect(validateNationalNumber(germany, "12345")).toBe("Germany numbers are 6–11 digits.");
  });

  test("asks for a number when the field is empty", () => {
    expect(validateNationalNumber(findCountry("GB"), "")).toBe("Please enter your phone number.");
  });
});
