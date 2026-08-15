import React from "react";
import { Radio, History } from "lucide-react";

function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

function formatTimeIST(value) {
  if (!value) return null;
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

// Explicit Live-vs-Historical banner (spec §9) — never lets a historical
// snapshot imply it's live data. `mode`/`date` come straight from
// /api/insights/snapshot's response.
export default function ModeBanner({ mode, date, generatedAt, crawlComplete }) {
  if (mode === "historical") {
    const time = formatTimeIST(generatedAt);
    return (
      <div className="insight-mode-banner insight-mode-banner-historical">
        <History size={16} />
        <div>
          <strong>Historical Snapshot — {formatDateLabel(date)}</strong>
          <span>{time ? `Captured at ${time} IST` : "Frozen record — not live data."}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="insight-mode-banner insight-mode-banner-live">
      <Radio size={16} />
      <div>
        <strong>Live Data</strong>
        <span>{crawlComplete ? "Full catalog counted" : "Catalog crawl in progress"} — source: Amber</span>
      </div>
    </div>
  );
}
