import React, { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { TableSkeleton } from "../SkeletonBlocks";
import ErrorState, { EmptyState } from "../ErrorState";

const COLUMNS = [
  { key: "name", label: "Property" },
  { key: "country", label: "Country" },
  { key: "city", label: "City" },
  { key: "locality", label: "Location" },
  { key: "pincode", label: "Pincode" },
  { key: "available", label: "Status" },
  { key: "minPrice", label: "Asking Price" },
];

function flattenProperties(cities) {
  return cities.filter((c) => c.cached).flatMap((c) => c.properties);
}

export default function PropertySection({ market, loading, error, onRetry, onResetFilters }) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("city");
  const [sortDir, setSortDir] = useState("asc");

  const properties = useMemo(() => (market ? flattenProperties(market.cities) : []), [market]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = q
      ? properties.filter((p) => [p.name, p.city, p.country, p.locality, p.pincode].some((v) => v && String(v).toLowerCase().includes(q)))
      : properties;
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [properties, search, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  if (loading) {
    return (
      <div className="insight-section">
        <TableSkeleton rows={10} />
      </div>
    );
  }
  if (error) return <ErrorState onRetry={onRetry} />;
  if (!market) return <EmptyState onReset={onResetFilters} />;

  return (
    <div className="insight-section">
      <div className="insight-section-intro">
        <h2>Property Performance</h2>
        <p>
          Up to 4 representative properties per market — a sample from Amber's full catalog crawl, not the complete
          listing. Sold %, average booked price and revenue columns are omitted here — IVYHUTS does not currently
          capture unit-level booking/transaction data.
        </p>
      </div>

      <div className="insight-card">
        <div className="insight-table-toolbar">
          <div className="insight-search-input">
            <Search size={15} />
            <input placeholder="Search property, city, pincode…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <span className="insight-table-count">{filtered.length.toLocaleString()} properties</span>
        </div>
        <div className="insight-table-scroll">
          <table className="insight-table">
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} onClick={() => toggleSort(col.key)} className="insight-table-sortable">
                    {col.label}
                    {sortKey === col.key && <span> {sortDir === "asc" ? "▲" : "▼"}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((p) => (
                <tr key={`${p.slug || p.id}-${p.city}`}>
                  <td>{p.name}</td>
                  <td>{p.country || "—"}</td>
                  <td>{p.city}</td>
                  <td>{p.locality || "—"}</td>
                  <td>{p.pincode || "—"}</td>
                  <td>
                    <span className={`insight-status-pill ${p.available ? "available" : "sold-out"}`}>{p.available ? "Available" : "Sold Out"}</span>
                  </td>
                  <td>{p.minPrice != null ? `${p.currency || ""}${p.minPrice.toLocaleString()}` : "—"}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={COLUMNS.length} className="insight-chart-empty">
                    No properties match this search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 200 && <p className="insight-card-sub">Showing first 200 of {filtered.length.toLocaleString()} — narrow your search to see more.</p>}
      </div>
    </div>
  );
}
