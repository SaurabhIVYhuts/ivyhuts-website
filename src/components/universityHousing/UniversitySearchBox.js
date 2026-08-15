import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search, GraduationCap, School, X } from "lucide-react";
import { searchCampusUniversities } from "../../lib/campusUniversityResolver";

// The page's primary input. Typing filters campusUniversities.json into a
// dropdown; selecting a suggestion IS the resolution — the caller gets the
// full canonical record (id/name/type/city/country/latitude/longitude)
// directly. Free text that's never selected resolves to nothing (no
// courtesy exact-match here, unlike the planner's autocomplete) — this
// page's whole flow depends on a real resolved institution, so an
// unresolved query simply keeps showing suggestions rather than silently
// guessing a match.
//
// Institution `type` ("UNIVERSITY" | "SCHOOL") is shown alongside every
// result — the search covers more than universities (e.g. Vamos Madrid, a
// language school), so making the type visible avoids a student assuming
// every result is a university.
const TYPE_LABELS = { UNIVERSITY: "University", SCHOOL: "School" };
function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.UNIVERSITY;
}
function TypeIcon({ type, size, className }) {
  const Icon = type === "SCHOOL" ? School : GraduationCap;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

export default function UniversitySearchBox({ selected, onSelect, onClear, autoFocus }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const suggestions = useMemo(() => searchCampusUniversities(query, 8), [query]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (selected) {
    return (
      <div className="uh-search-selected">
        <TypeIcon type={selected.type} size={18} className="uh-search-selected-icon" />
        <div className="uh-search-selected-body">
          <span className="uh-search-selected-name">{selected.name}</span>
          <span className="uh-search-selected-type">{typeLabel(selected.type)}</span>
          <span className="uh-search-selected-loc">{selected.city}, {selected.country}</span>
        </div>
        <button type="button" className="uh-search-change" onClick={onClear}>
          <X size={14} /> Change
        </button>
      </div>
    );
  }

  return (
    <div className="uh-search-box" ref={containerRef}>
      <Search size={18} className="uh-search-icon" aria-hidden="true" />
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search your university or school…"
        aria-label="Search your university or school"
        autoComplete="off"
        autoFocus={autoFocus}
        maxLength={120}
      />
      {open && suggestions.length > 0 && (
        <ul className="uh-search-suggestions">
          {suggestions.map((uni) => (
            <li key={uni.id}>
              <button
                type="button"
                onClick={() => { onSelect(uni); setQuery(""); setOpen(false); }}
              >
                <TypeIcon type={uni.type} size={15} className="uh-search-suggestion-icon" />
                <span className="uh-search-suggestion-text">
                  <span className="uh-search-suggestion-name">{uni.name}</span>
                  <span className="uh-search-suggestion-type">{typeLabel(uni.type)}</span>
                  <span className="uh-search-suggestion-loc">{uni.city}, {uni.country}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && suggestions.length === 0 && (
        <div className="uh-search-suggestions uh-search-no-match">
          No university or school matches "{query.trim()}" yet — try a different spelling, or browse{" "}
          <Link to="/find-rooms">all cities</Link> instead.
        </div>
      )}
    </div>
  );
}
