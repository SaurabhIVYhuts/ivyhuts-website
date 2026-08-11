import React from "react";
import { DESTINATIONS, COUNTRIES } from "../../../data/destinations";

const RANGE_PRESETS = [
  { key: "7d", label: "Last 7 Days", days: 7 },
  { key: "30d", label: "Last 30 Days", days: 30 },
  { key: "90d", label: "Last 90 Days", days: 90 },
  { key: "365d", label: "Last 12 Months", days: 365 },
];

export function rangeFromPreset(key) {
  const preset = RANGE_PRESETS.find((r) => r.key === key) || RANGE_PRESETS[1];
  const to = new Date();
  const from = new Date(to.getTime() - preset.days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function FilterBar({ filters, onChange, onReset, sourceOptions }) {
  const set = (patch) => onChange({ ...filters, ...patch });

  return (
    <div className="insight-filterbar">
      <select
        className="insight-filter-select"
        value={filters.rangeKey}
        onChange={(e) => set({ rangeKey: e.target.value, ...rangeFromPreset(e.target.value) })}
      >
        {RANGE_PRESETS.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>

      <select className="insight-filter-select" value={filters.country || ""} onChange={(e) => set({ country: e.target.value || undefined, city: undefined })}>
        <option value="">All Countries</option>
        {COUNTRIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <select className="insight-filter-select" value={filters.city || ""} onChange={(e) => set({ city: e.target.value || undefined })}>
        <option value="">All Cities</option>
        {DESTINATIONS.filter((d) => !filters.country || d.country === filters.country).map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>

      {sourceOptions && sourceOptions.length > 0 && (
        <select className="insight-filter-select" value={filters.source || ""} onChange={(e) => set({ source: e.target.value || undefined })}>
          <option value="">All Sources</option>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      )}

      <button type="button" className="insight-filter-reset" onClick={onReset}>
        Reset Filters
      </button>
    </div>
  );
}

export { RANGE_PRESETS };
