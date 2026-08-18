import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search, GraduationCap, School, X, Loader2, MapPin, Link2 } from "lucide-react";
import { searchCampusUniversities } from "../../lib/campusUniversityResolver";
import { searchUniversityDiscovery, confirmUniversityCandidate } from "../../services/universityDiscoveryApi";
import { parseGoogleMapsUrl, MAX_URL_LENGTH } from "../../lib/googleMapsParser";

// The page's primary input. Two independent paths, deliberately kept apart:
//
// 1. TYPING -> live Tier-1-only suggestions (searchCampusUniversities,
//    pure local JSON lookup). Clicking a suggestion resolves instantly with
//    ZERO network calls. This is unchanged from before this milestone and
//    must stay that way — typing must never trigger a server request, let
//    alone an AI or Amber one.
// 2. SEARCHING -> pressing Enter or the explicit Search button submits the
//    current text to /api/universities/resolve (Tier 1 -> Tier 2 -> local
//    fuzzy -> AI-assisted interpretation -> Nominatim; all server-side, see
//    api/_lib/universityResolveService.js). This is the ONLY thing that can
//    surface a university not already in campusUniversities.json. It is an
//    explicit, deliberate user action — never fired automatically while
//    typing, and never fired twice concurrently (the button/input disable
//    while a search is in flight, and the query itself is what's disabled
//    during "ambiguous"/"not_found"/"unavailable" so the user can't
//    double-submit while reading the result).
//
// Either path terminates the same way: onSelect(record) with a full
// canonical record ({id, name, type, city, country, address, latitude,
// longitude}) — the parent (UniversityHousingPage.js) never knows or cares
// which tier resolved it.
//
// A third input form rides the SEARCHING path above rather than adding a
// new one: pasting a Google Maps link — either a full URL (coordinates/name
// already in the URL text) or a maps.app.goo.gl/goo.gl/share.google short
// link (no coordinates in the URL text; the server resolves the redirect
// first — see api/_lib/googleMapsShortLinkResolver.js). Detection
// (src/lib/googleMapsParser.js) happens locally, before any network call, so
// an obviously bad paste (wrong host, a full URL with no coordinates/name at
// all) is answered instantly at zero AI/Nominatim/Amber/redirect-resolution
// cost. Anything else, including a short link, is sent through the SAME
// /api/universities/resolve endpoint as a normal search — the server
// re-parses and independently verifies it server-side (see
// resolveGoogleMapsCandidate() in api/_lib/universityResolveService.js)
// rather than trusting anything computed here.
const TYPE_LABELS = { UNIVERSITY: "University", SCHOOL: "School" };
function typeLabel(type) {
  return TYPE_LABELS[type] || TYPE_LABELS.UNIVERSITY;
}
function TypeIcon({ type, size, className }) {
  const Icon = type === "SCHOOL" ? School : GraduationCap;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

// idle: input + Tier-1 typeahead, as before.
// searching: a resolve() request is in flight — input/button disabled.
// ambiguous: multiple real candidates found — user must explicitly choose one, never a silent guess.
// not_found / unavailable: a clear, non-technical explanation + a way to try again or browse all cities.
export default function UniversitySearchBox({ selected, onSelect, onClear, autoFocus }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [searchState, setSearchState] = useState("idle");
  const [candidates, setCandidates] = useState([]);
  const [confirmingId, setConfirmingId] = useState(null);
  const containerRef = useRef(null);
  const abortRef = useRef(null);
  const submittedQueryRef = useRef("");
  const suggestions = useMemo(() => searchCampusUniversities(query, 8), [query]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  function resetSearchResult() {
    setSearchState("idle");
    setCandidates([]);
  }

  function handleTypeaheadSelect(uni) {
    abortRef.current?.abort();
    resetSearchResult();
    onSelect(uni);
    setQuery("");
    setOpen(false);
  }

  async function runSearch(rawQuery) {
    const trimmed = rawQuery.trim();
    if (!trimmed || searchState === "searching") return; // no duplicate submissions

    // Google Maps URL detection happens BEFORE any network call — a
    // recognized-but-unsupported form (wrong host, or a full URL with no
    // usable name/coordinates) is answered instantly and locally, never sent
    // through AI/Nominatim/Amber. A short link (maps.app.goo.gl/goo.gl/maps)
    // carries no coordinates in the URL text itself, so it can't be
    // validated locally — it still goes through the request below, where the
    // server resolves the redirect (see googleMapsShortLinkResolver.js)
    // before parsing/verifying it the same way as any full URL.
    if (/^https?:\/\//i.test(trimmed)) {
      const parsed = parseGoogleMapsUrl(trimmed);
      if (!parsed.isGoogleMapsUrl) {
        abortRef.current?.abort();
        setOpen(false);
        setCandidates([]);
        setSearchState("invalid_maps_url");
        return;
      }
      if (!parsed.isShortLink && !parsed.name && parsed.latitude == null) {
        abortRef.current?.abort();
        setOpen(false);
        setCandidates([]);
        setSearchState("invalid_location");
        return;
      }
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    submittedQueryRef.current = trimmed;
    setOpen(false);
    setSearchState("searching");
    setCandidates([]);

    try {
      const result = await searchUniversityDiscovery(trimmed, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.status === "resolved") {
        onSelect(result.data);
        setQuery("");
        resetSearchResult();
      } else if (result.status === "ambiguous") {
        setCandidates(Array.isArray(result.data) ? result.data : []);
        setSearchState("ambiguous");
      } else if (["short_link_unresolved", "invalid_location", "maps_no_institution", "not_found"].includes(result.status)) {
        // invalid_location/maps_no_institution are also handled here (not
        // just the local pre-check above) since the server is the
        // authoritative parser — this covers any input the client-side
        // pre-check didn't already intercept. short_link_unresolved only
        // ever comes from the server — a short link's redirect can't be
        // resolved locally, so there's no client-side equivalent to pre-empt.
        setSearchState(result.status);
      } else {
        setSearchState("unavailable");
      }
    } catch (err) {
      if (err.name === "AbortError" || controller.signal.aborted) return;
      setSearchState("unavailable");
    }
  }

  async function handleConfirmCandidate(candidate) {
    if (confirmingId) return; // no duplicate submissions
    setConfirmingId(candidate.id || candidate.name);
    try {
      const result = await confirmUniversityCandidate(submittedQueryRef.current, candidate);
      if (result.status === "resolved") {
        onSelect(result.data);
        setQuery("");
        resetSearchResult();
      } else {
        setSearchState("unavailable");
      }
    } finally {
      setConfirmingId(null);
    }
  }

  function handleSubmit(e) {
    e.preventDefault(); // never a full page reload — same path for Enter and the Search button
    runSearch(query);
  }

  function handleTryAgain() {
    resetSearchResult();
    setOpen(true);
  }

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

  const isSearching = searchState === "searching";
  const disabled = isSearching;

  return (
    <div className="uh-search-box" ref={containerRef}>
      <form className="uh-search-form" onSubmit={handleSubmit}>
        <Search size={18} className="uh-search-icon" aria-hidden="true" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (searchState !== "idle") resetSearchResult();
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search university/school name or paste a Google Maps link"
          aria-label="Search your university or school name, or paste a Google Maps link"
          autoComplete="off"
          autoFocus={autoFocus}
          maxLength={MAX_URL_LENGTH}
          disabled={disabled}
        />
        <button type="submit" className="uh-search-submit" disabled={disabled || !query.trim()} aria-label="Search">
          {isSearching ? <Loader2 size={16} className="uh-search-spin" /> : "Search"}
        </button>
      </form>

      {!open && searchState === "idle" && (
        <p className="uh-search-hint">
          <Link2 size={12} aria-hidden="true" /> Tip: you can also paste a Google Maps link
        </p>
      )}

      {open && searchState === "idle" && suggestions.length > 0 && (
        <ul className="uh-search-suggestions">
          {suggestions.map((uni) => (
            <li key={uni.id}>
              <button type="button" onClick={() => handleTypeaheadSelect(uni)}>
                <TypeIcon type={uni.type} size={15} className="uh-search-suggestion-icon" />
                <span className="uh-search-suggestion-text">
                  <span className="uh-search-suggestion-name">{uni.name}</span>
                  <span className="uh-search-suggestion-type">{typeLabel(uni.type)}</span>
                  <span className="uh-search-suggestion-loc">{uni.city}, {uni.country}</span>
                </span>
              </button>
            </li>
          ))}
          <li className="uh-search-suggestions-footer">
            Can't find it? Press Enter or Search to look it up.
          </li>
        </ul>
      )}

      {open && searchState === "idle" && query.trim() && suggestions.length === 0 && (
        <div className="uh-search-suggestions uh-search-no-match">
          No quick match for "{query.trim()}" yet — press Enter or Search to look it up properly.
        </div>
      )}

      {searchState === "searching" && (
        <div className="uh-search-suggestions uh-search-status" aria-live="polite" aria-busy="true">
          <Loader2 size={16} className="uh-search-spin" />{" "}
          {/^https?:\/\//i.test(submittedQueryRef.current)
            ? "Locating place…"
            : `Looking up "${submittedQueryRef.current}"…`}
        </div>
      )}

      {searchState === "ambiguous" && (
        <div className="uh-search-suggestions uh-search-ambiguous" aria-live="polite">
          <p className="uh-search-ambiguous-title">We found a few possible matches for "{submittedQueryRef.current}" — which one did you mean?</p>
          <ul>
            {candidates.map((c) => (
              <li key={c.id || c.name}>
                <button
                  type="button"
                  className="uh-search-candidate"
                  disabled={Boolean(confirmingId)}
                  onClick={() => handleConfirmCandidate(c)}
                >
                  <TypeIcon type={c.type} size={15} className="uh-search-suggestion-icon" />
                  <span className="uh-search-suggestion-text">
                    <span className="uh-search-suggestion-name">{c.name}</span>
                    <span className="uh-search-suggestion-loc"><MapPin size={11} /> {c.city ? `${c.city}, ` : ""}{c.country || "Location unknown"}</span>
                  </span>
                  {confirmingId === (c.id || c.name) && <Loader2 size={14} className="uh-search-spin" />}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>None of these — try a different search</button>
        </div>
      )}

      {searchState === "not_found" && (
        <div className="uh-search-suggestions uh-search-status uh-search-status-empty" aria-live="polite">
          <p>We couldn't find "{submittedQueryRef.current}" — check the spelling, or{" "}
            <Link to="/find-rooms">browse all cities</Link> instead.</p>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>Try a different search</button>
        </div>
      )}

      {searchState === "unavailable" && (
        <div className="uh-search-suggestions uh-search-status uh-search-status-empty" aria-live="polite">
          <p>University search is temporarily unavailable — please try again in a moment, or{" "}
            <Link to="/find-rooms">browse all cities</Link> instead.</p>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>Try again</button>
        </div>
      )}

      {searchState === "invalid_maps_url" && (
        <div className="uh-search-suggestions uh-search-status uh-search-status-empty" aria-live="polite">
          <p>That Google Maps link doesn't look valid. Please paste the complete Maps link.</p>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>Try again</button>
        </div>
      )}

      {searchState === "short_link_unresolved" && (
        <div className="uh-search-suggestions uh-search-status uh-search-status-empty" aria-live="polite">
          <p>We couldn't resolve that Google Maps location. Please try opening it in Google Maps and copying the link again.</p>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>Try again</button>
        </div>
      )}

      {searchState === "invalid_location" && (
        <div className="uh-search-suggestions uh-search-status uh-search-status-empty" aria-live="polite">
          <p>We found the link, but couldn't identify the location. Please try the full university or school name.</p>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>Try again</button>
        </div>
      )}

      {searchState === "maps_no_institution" && (
        <div className="uh-search-suggestions uh-search-status uh-search-status-empty" aria-live="polite">
          <p>We found the location, but couldn't confidently identify the university. Try the official university name.</p>
          <button type="button" className="uh-search-try-again" onClick={handleTryAgain}>Try again</button>
        </div>
      )}
    </div>
  );
}
