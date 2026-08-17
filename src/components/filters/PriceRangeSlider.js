import React, { useEffect, useState } from "react";
import "./PriceRangeSlider.css";

// Dual-thumb budget range — two overlapping native <input type="range">
// (no slider dependency needed) plus numeric min/max inputs. Bounds (`min`/
// `max`) and `currency`/`duration` are always derived by the caller from the
// CURRENT result set's real prices (see PropertyListingPage's
// priceBounds/priceCurrency), never hardcoded — a property's own reported
// currency is what's shown, matching this codebase's multi-currency reality
// (Amber properties price in £/€/$/AED depending on country).
//
// Drags update local state continuously for a smooth handle; `onChange`
// (which the caller wires to the URL-backed filter state) only fires on
// release/blur — committing on every drag tick would spam navigation.
export default function PriceRangeSlider({ min, max, valueMin, valueMax, currency = "", duration = "", onChange }) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 100;

  const [localMin, setLocalMin] = useState(Number.isFinite(valueMin) ? valueMin : lo);
  const [localMax, setLocalMax] = useState(Number.isFinite(valueMax) ? valueMax : hi);

  useEffect(() => { setLocalMin(Number.isFinite(valueMin) ? valueMin : lo); }, [valueMin, lo]);
  useEffect(() => { setLocalMax(Number.isFinite(valueMax) ? valueMax : hi); }, [valueMax, hi]);

  function commit(nextMin, nextMax) {
    const m = Math.round(Math.min(nextMin, nextMax));
    const x = Math.round(Math.max(nextMin, nextMax));
    onChange({ min: m <= lo ? "" : String(m), max: x >= hi ? "" : String(x) });
  }

  function onMinDrag(e) {
    const v = Math.min(Number(e.target.value), localMax);
    setLocalMin(v);
  }
  function onMaxDrag(e) {
    const v = Math.max(Number(e.target.value), localMin);
    setLocalMax(v);
  }

  function onMinNumberInput(e) {
    const v = e.target.value === "" ? lo : Math.max(lo, Math.min(Number(e.target.value) || lo, localMax));
    setLocalMin(v);
    commit(v, localMax);
  }
  function onMaxNumberInput(e) {
    const v = e.target.value === "" ? hi : Math.min(hi, Math.max(Number(e.target.value) || hi, localMin));
    setLocalMax(v);
    commit(localMin, v);
  }

  const range = hi - lo || 1;
  const leftPct = ((localMin - lo) / range) * 100;
  const rightPct = ((localMax - lo) / range) * 100;
  const durationLabel = duration ? `/${duration}` : "";

  return (
    <div className="price-range-slider">
      <div className="price-range-readout">
        {currency}{Math.round(localMin)} – {currency}{Math.round(localMax)}{durationLabel}
      </div>
      <div className="price-range-track-wrap">
        <div className="price-range-track" />
        <div className="price-range-track-fill" style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }} />
        <input
          type="range"
          className="price-range-input price-range-input--min"
          min={lo}
          max={hi}
          value={localMin}
          onChange={onMinDrag}
          onMouseUp={() => commit(localMin, localMax)}
          onTouchEnd={() => commit(localMin, localMax)}
          onKeyUp={() => commit(localMin, localMax)}
          aria-label="Minimum price"
        />
        <input
          type="range"
          className="price-range-input price-range-input--max"
          min={lo}
          max={hi}
          value={localMax}
          onChange={onMaxDrag}
          onMouseUp={() => commit(localMin, localMax)}
          onTouchEnd={() => commit(localMin, localMax)}
          onKeyUp={() => commit(localMin, localMax)}
          aria-label="Maximum price"
        />
      </div>
      <div className="price-range-numbers">
        <label>
          Minimum
          <div className="price-range-number-field">
            <span>{currency}</span>
            <input type="number" inputMode="numeric" min={lo} max={localMax} value={Math.round(localMin)} onChange={onMinNumberInput} />
          </div>
        </label>
        <label>
          Maximum
          <div className="price-range-number-field">
            <span>{currency}</span>
            <input type="number" inputMode="numeric" min={localMin} max={hi} value={Math.round(localMax)} onChange={onMaxNumberInput} />
          </div>
        </label>
      </div>
    </div>
  );
}
