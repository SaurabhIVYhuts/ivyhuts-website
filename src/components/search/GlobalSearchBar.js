import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MapPin, Globe, GraduationCap, Search } from "lucide-react";
import { buildSearchUrl, buildPropertyQueryUrl } from "../../lib/searchNavigation";
import { searchAllEntities, ensureSearchDataLoaded } from "../../lib/entitySearch";
import { addRecentSearch } from "../../services/recentActivity";
import "./GlobalSearchBar.css";

const EMPTY_RESULTS = { cities: [], universities: [], countries: [], best: null, bestConfident: false };

// Properties are intentionally OUT OF SCOPE for this phase (explicit product
// decision) — the Global Search only covers countries/cities/universities,
// all served from src/lib/entitySearch.js's in-memory index (curated data,
// bundled, plus the comprehensive dataset fetched ONCE from /api/search-data —
// never per keystroke). This is why there is no debounce, no
// AbortController, no per-keystroke fetch here anymore: every match is a
// synchronous, local computation, so results update the instant a keystroke
// lands. Re-adding property search later means adding a "properties" entry
// back to GROUP_CONFIG and a network-backed lookup for it — everything else
// here (ranking, ambiguity handling, keyboard nav) already generalizes.
const GROUP_CONFIG = [
  { key: "cities", label: "Cities", Icon: MapPin },
  { key: "countries", label: "Countries", Icon: Globe },
  { key: "universities", label: "Universities", Icon: GraduationCap },
];

// Universal IVYHUTS search — understands country/city/university without the
// user needing to say which. Used on the homepage hero and reusable anywhere
// else a global (not in-results) search is needed.
export default function GlobalSearchBar({
  placeholder = "Search by city or university",
  mobilePlaceholder = "Search by",
  autoFocus = false,
  className = "",
  onNavigate,
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  // Kicks off the ONE fetch of the comprehensive dataset for this page
  // session (see entitySearch.js's own header) — non-blocking; typing works
  // immediately off the bundled curated data regardless of when/whether this
  // resolves, and every subsequent keystroke automatically searches the
  // fuller dataset once it lands (searchAllEntities always reads whatever's
  // currently loaded, no separate "loading" state to thread through here).
  useEffect(() => {
    ensureSearchDataLoaded();
  }, []);

  const trimmedValue = value.trim();

  // Pure, synchronous, in-memory — no network, no debounce needed (target
  // <100ms even over the full comprehensive dataset, see entitySearch.js).
  const results = useMemo(() => {
    if (!trimmedValue) return EMPTY_RESULTS;
    return searchAllEntities(trimmedValue, 5);
  }, [trimmedValue]);

  useEffect(() => { setActiveIndex(-1); }, [trimmedValue]);

  const flatItems = useMemo(() => {
    const list = [];
    GROUP_CONFIG.forEach(({ key }) => results[key]?.forEach((item) => list.push(item)));
    return list;
  }, [results]);

  const hasResults = flatItems.length > 0;

  function goToEntity(entity) {
    setOpen(false);
    addRecentSearch(entity.label);
    if (onNavigate) { onNavigate(entity); return; }
    navigate(buildSearchUrl(entity));
  }

  // Enter with nothing highlighted (or the search button): only auto-
  // navigates when the resolved "best" entity is unambiguous (bestConfident)
  // — an ambiguous match (e.g. a tie between a city and a university)
  // surfaces the dropdown for the user to choose instead of guessing. A true
  // non-match falls back to the existing raw property-search path
  // (PropertyListingPage's own ?property= resolution — unaffected by
  // properties being out of THIS component's scope).
  function submitRaw() {
    const q = value.trim();
    if (!q) return;
    addRecentSearch(q);
    if (results.best && results.bestConfident) { goToEntity(results.best); return; }
    if (results.best && !results.bestConfident) { setOpen(true); return; } // ambiguous — let the user pick
    setOpen(false);
    if (onNavigate) { onNavigate({ type: "property", label: q, slug: null, value: {} }); return; }
    navigate(buildPropertyQueryUrl(q));
  }

  function handleKeyDown(e) {
    if (!open || !hasResults) {
      if (e.key === "Enter") { e.preventDefault(); submitRaw(); }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flatItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? flatItems.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && flatItems[activeIndex]) goToEntity(flatItems[activeIndex]);
      else submitRaw();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showDropdown = open && trimmedValue.length > 0;
  let runningIndex = -1;

  return (
    <form
      className={`gsb-form ${className}`}
      role="search"
      onSubmit={(e) => { e.preventDefault(); submitRaw(); }}
    >
      <div className="gsb-input-wrap">
        <Search className="gsb-icon gsb-icon-search desktop-only-icon" size={18} aria-hidden="true" />
        <input
          type="text"
          className="gsb-input desktop-only-input"
          placeholder={placeholder}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => { setValue(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          aria-label={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          aria-controls="gsb-listbox"
        />
        <input
          type="text"
          className="gsb-input mobile-only-input"
          placeholder={mobilePlaceholder}
          value={value}
          onChange={(e) => { setValue(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={handleKeyDown}
          aria-label={mobilePlaceholder}
          autoComplete="off"
        />
        {value && (
          <button type="button" className="gsb-clear" aria-label="Clear search" onMouseDown={() => setValue("")}>
            ×
          </button>
        )}

        {showDropdown && (
          <div className="gsb-dropdown" role="listbox" id="gsb-listbox">
            {hasResults ? (
              <div className="gsb-dropdown-scroll">
                {GROUP_CONFIG.map(({ key, label, Icon }) => {
                  const items = results[key];
                  if (!items || items.length === 0) return null;
                  return (
                    <div className="gsb-group" key={key}>
                      <div className="gsb-group-label">{label}</div>
                      {items.map((item) => {
                        runningIndex += 1;
                        const idx = runningIndex;
                        return (
                          <button
                            type="button"
                            key={`${item.type}-${item.id}`}
                            className={`gsb-item${idx === activeIndex ? " gsb-item--active" : ""}`}
                            onMouseDown={() => goToEntity(item)}
                            onMouseEnter={() => setActiveIndex(idx)}
                            role="option"
                            aria-selected={idx === activeIndex}
                          >
                            <Icon size={15} className="gsb-item-icon" aria-hidden="true" />
                            <span className="gsb-item-label">{item.label}</span>
                            {item.sublabel && <span className="gsb-item-sublabel">{item.sublabel}</span>}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="gsb-empty">No matches for "{trimmedValue}" — press Enter to search anyway.</div>
            )}
          </div>
        )}
      </div>
      <button type="submit" className="gsb-submit-btn">
        <span className="gsb-submit-text">Find Rooms →</span>
        <Search className="gsb-submit-icon" size={18} aria-hidden="true" />
      </button>
    </form>
  );
}
