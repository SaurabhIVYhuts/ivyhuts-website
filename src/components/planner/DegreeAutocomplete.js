import React, { useEffect, useMemo, useRef, useState } from "react";
import { searchDegrees } from "../../lib/degreeResolver";

// Replaces the plain Degree <input> (Milestone 5). Same interaction pattern
// as UniversityAutocomplete.js: typing filters the local degree suggestion
// dataset into a dropdown; selecting a suggestion IS the resolution — the
// caller gets the canonical { id, name } directly.
//
// If the student never selects a suggestion, this behaves like the old
// plain text input (free text) — api/student-planner.js still attempts a
// courtesy exact/alias resolve server-side, and an unresolved degree
// degrades to a controlled "not yet in our dataset" state rather than
// blocking submission.
export default function DegreeAutocomplete({ value, onChange, resolved, onSelect, onClear, error }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const suggestions = useMemo(() => searchDegrees(value), [value]);

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
        <label>Degree <span className="sp-req">*</span></label>
        <div className="sp-university-selected">
          <span>{resolved.name}</span>
          <button type="button" className="sp-university-change" onClick={onClear}>Change</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sp-field sp-university-autocomplete" ref={containerRef}>
      <label>Degree <span className="sp-req">*</span></label>
      <input
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        maxLength={120}
        placeholder="e.g. BSc Computer Science"
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="sp-university-suggestions">
          {suggestions.map((degree) => (
            <li key={degree.id}>
              <button type="button" onClick={() => { onSelect(degree); setOpen(false); }}>
                <span className="sp-university-suggestion-name">{degree.name}</span>
                <span className="sp-university-suggestion-loc">{degree.category}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="sp-field-err">{error}</span>}
    </div>
  );
}
