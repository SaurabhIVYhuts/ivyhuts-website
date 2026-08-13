import React, { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { getInsightsSnapshotDates } from "../../../services/insightsApi";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// IST calendar day, matching api/_lib/insightsSnapshotStore.js's
// istDateString() exactly — the frontend and backend must agree on what
// "today" means or the live/historical boundary would drift.
function toDateString(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}
function todayIST() {
  return toDateString(new Date());
}
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function formatMonthLabel(d) {
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}
function formatSelectedLabel(dateStr) {
  if (!dateStr) return "Today — Live";
  const [y, m, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Monday-first 6x7 grid of Date objects covering `monthDate`'s month,
// including the leading/trailing days from adjacent months needed to fill
// full weeks — matches the spec's example calendar layout exactly.
function buildGrid(monthDate) {
  const year = monthDate.getFullYear();
  const month = monthDate.getMonth();
  const first = new Date(year, month, 1);
  const firstWeekday = (first.getDay() + 6) % 7; // 0=Mon .. 6=Sun
  const start = new Date(year, month, 1 - firstWeekday);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

// selectedDate: "YYYY-MM-DD" or null (null = today/live). onSelect receives
// the same shape — clicking today (or the "Back to Live" button) passes
// null so InsightPage.js switches back to the live-polling data path.
export default function InsightCalendar({ selectedDate, onSelect }) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    if (selectedDate) {
      const [y, m] = selectedDate.split("-").map(Number);
      return new Date(y, m - 1, 1);
    }
    return new Date();
  });
  const [availableDates, setAvailableDates] = useState(new Set());
  const containerRef = useRef(null);
  const today = todayIST();

  useEffect(() => {
    let cancelled = false;
    getInsightsSnapshotDates({ month: monthKey(viewMonth) })
      .then((data) => {
        if (!cancelled) setAvailableDates(new Set((data?.dates || []).map((d) => d.date)));
      })
      .catch(() => {
        if (!cancelled) setAvailableDates(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [viewMonth]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const grid = useMemo(() => buildGrid(viewMonth), [viewMonth]);

  return (
    <div className="insight-calendar" ref={containerRef}>
      <button type="button" className="insight-calendar-trigger" onClick={() => setOpen((o) => !o)}>
        <CalendarIcon size={15} />
        {formatSelectedLabel(selectedDate)}
      </button>
      {open && (
        <div className="insight-calendar-popover">
          <div className="insight-calendar-nav">
            <button type="button" onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <span>{formatMonthLabel(viewMonth)}</span>
            <button type="button" onClick={() => setViewMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="insight-calendar-weekdays">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="insight-calendar-grid">
            {grid.map((d) => {
              const dateStr = toDateString(d);
              const inMonth = d.getMonth() === viewMonth.getMonth();
              const isFuture = dateStr > today;
              const isToday = dateStr === today;
              const isSelected = selectedDate ? dateStr === selectedDate : isToday;
              const hasSnapshot = availableDates.has(dateStr);
              return (
                <button
                  key={dateStr}
                  type="button"
                  disabled={isFuture}
                  title={hasSnapshot ? "Snapshot available" : undefined}
                  className={[
                    "insight-calendar-day",
                    !inMonth && "insight-calendar-day-outside",
                    isToday && "insight-calendar-day-today",
                    isSelected && "insight-calendar-day-selected",
                    hasSnapshot && "insight-calendar-day-has-data",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => {
                    onSelect(isToday ? null : dateStr);
                    setOpen(false);
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          {selectedDate && (
            <button
              type="button"
              className="insight-calendar-today-btn"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
            >
              Back to Live
            </button>
          )}
        </div>
      )}
    </div>
  );
}
