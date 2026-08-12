import React, { useEffect, useMemo, useRef, useState } from "react";
import { searchUniversities } from "../../lib/universityResolver";

// Replaces the plain University <input>. Typing filters the local
// universities.json into a dropdown; selecting a suggestion IS the
// resolution — the caller gets the full canonical record (id/name/city/
// country/latitude/longitude) directly, no separate resolve step needed.
//
// If the student never selects a suggestion, this behaves exactly like the
// old plain text input (free text, city/country stay manually editable) —
// the Milestone 1/2 fallback path is fully preserved.
export default function UniversityAutocomplete({ value, onChange, resolved, onSelect, onClear, error }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const suggestions = useMemo(() => searchUniversities(value), [value]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (resolved) {
    return (
      <div className="sp-field">
        <label>University <span className="sp-req">*</span></label>
        <div className="sp-university-selected">
          <span>{resolved.name}</span>
          <button type="button" className="sp-university-change" onClick={onClear}>Change</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-field sp-university-autocomplete" ref={containerRef}>
      <label>University <span className="sp-req">*</span></label>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        maxLength={120}
        placeholder="e.g. University of Manchester"
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="sp-university-suggestions">
          {suggestions.map((uni) => (
            <li key={uni.id}>
              <button type="button" onClick={() => { onSelect(uni); setOpen(false); }}>
                <span className="sp-university-suggestion-name">{uni.name}</span>
                <span className="sp-university-suggestion-loc">{uni.city}, {uni.country}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="sp-field-err">{error}</span>}
    </div>
  );
}
