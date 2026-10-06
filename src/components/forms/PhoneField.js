import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import COUNTRY_DIAL_CODES, { searchCountries } from "../../data/countryDialCodes";
import "./PhoneField.css";

// One phone control shared by every lead form (homepage popup + contact
// page), so the dial-code list, the per-country digit limit and the
// formatting of what finally gets submitted can never drift between them.
// The length rules themselves live in src/data/countryDialCodes.js — this
// file is only the UI.
//
// Deliberately a custom combobox rather than a native <select>: with ~90
// countries a native select is an unsearchable scroll on desktop, and the
// search box here means someone types "ire" or "353" instead of hunting.
// Everything a native select gives for free is re-implemented explicitly
// below: keyboard navigation, Escape to close, outside-click to close,
// and listbox/option roles for screen readers.
//
// The parent owns the state (country + national digits) and renders its
// own label/error text in its own form's style — this component renders
// only the control itself.
export default function PhoneField({
  country,
  onCountryChange,
  value,
  onChange,
  invalid = false,
  inputId,
  autoComplete = "tel",
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // The panel is positioned `fixed` against the control's own rect rather
  // than absolutely inside it: the homepage popup is a scroll container
  // (`.lead-popup { overflow-y: auto }`), which would clip an absolutely
  // positioned child that extends past the modal's padding box — exactly
  // what a dropdown under the last field does. Fixed escapes that clipping.
  // It also flips above the control when there isn't room below.
  const [anchor, setAnchor] = useState(null);

  const wrapperRef = useRef(null);
  const buttonRef = useRef(null);
  const searchRef = useRef(null);
  const listRef = useRef(null);

  const matches = searchCountries(query);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector('[data-active="true"]');
    // Feature-checked rather than called blind: scrollIntoView is missing in
    // jsdom (and a few embedded webviews), where throwing here would take
    // the whole form down with it over a cosmetic scroll.
    if (typeof activeEl?.scrollIntoView === "function") activeEl.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  // A fixed panel can't follow the page, so close on scroll/resize rather
  // than leave it floating next to nothing.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const openPanel = () => {
    const controlEl = wrapperRef.current?.querySelector(".phone-field-control");
    const rect = controlEl?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const up = spaceBelow < 300 && spaceAbove > spaceBelow;
      setAnchor({
        left: rect.left,
        width: rect.width,
        up,
        // Pinned to one edge and capped at the room actually available, so
        // the list never runs off the top or bottom of the screen.
        ...(up
          ? { bottom: window.innerHeight - rect.top + 6, maxHeight: Math.min(320, spaceAbove - 16) }
          : { top: rect.bottom + 6, maxHeight: Math.min(320, spaceBelow - 16) }),
      });
    }
    setQuery("");
    setActiveIndex(Math.max(0, COUNTRY_DIAL_CODES.findIndex((c) => c.code === country.code)));
    setOpen(true);
  };

  const select = (next) => {
    onCountryChange(next);
    // A number already typed for a longer country must not survive past
    // the new country's limit — truncating here keeps the visible value
    // and the maxLength in agreement instead of leaving an over-long
    // number the user can't see is over-long.
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length > next.max) onChange(digits.slice(0, next.max));
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onSearchKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (matches[activeIndex]) select(matches[activeIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  const hint = country.min === country.max ? `${country.min}-digit number` : "Phone number";

  return (
    <div className={`phone-field${invalid ? " phone-field--invalid" : ""}`} ref={wrapperRef}>
      <div className="phone-field-control">
        <button
          type="button"
          ref={buttonRef}
          className="phone-field-country"
          onClick={() => (open ? setOpen(false) : openPanel())}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Country code: ${country.name} ${country.dial}`}
        >
          <span className="phone-field-flag" aria-hidden="true">{country.flag}</span>
          <span className="phone-field-dial">{country.dial}</span>
          <ChevronDown size={14} strokeWidth={2.5} className={`phone-field-chevron${open ? " phone-field-chevron--open" : ""}`} aria-hidden="true" />
        </button>

        <input
          id={inputId}
          type="tel"
          inputMode="numeric"
          autoComplete={autoComplete}
          className="phone-field-input"
          placeholder={hint}
          value={value}
          maxLength={country.max}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, country.max))}
        />
      </div>

      {open && anchor && (
        <div
          className="phone-field-panel"
          style={{
            left: anchor.left,
            width: anchor.width,
            maxHeight: anchor.maxHeight,
            ...(anchor.up ? { bottom: anchor.bottom } : { top: anchor.top }),
          }}
        >
          <div className="phone-field-search">
            <Search size={14} strokeWidth={2.25} aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder="Search country or code"
              onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
              onKeyDown={onSearchKeyDown}
              aria-label="Search for a country"
            />
          </div>

          <ul className="phone-field-list" role="listbox" ref={listRef}>
            {matches.map((c, i) => (
              <li key={c.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={c.code === country.code}
                  data-active={i === activeIndex ? "true" : "false"}
                  className={`phone-field-option${c.code === country.code ? " phone-field-option--selected" : ""}${i === activeIndex ? " phone-field-option--active" : ""}`}
                  onClick={() => select(c)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className="phone-field-flag" aria-hidden="true">{c.flag}</span>
                  <span className="phone-field-option-name">{c.name}</span>
                  <span className="phone-field-option-dial">{c.dial}</span>
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="phone-field-empty">No country matches “{query}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
