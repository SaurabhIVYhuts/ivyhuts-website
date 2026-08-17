import React from "react";
import { Check, TriangleAlert } from "lucide-react";

// Section 5 — a compact comparison over the same residences already
// recommended above (no separate selection UI for this milestone).
//
// Milestone 4: an optional "Budget Fit" column (item 16) when the student
// supplied a weekly accommodation budget. Compares against
// residence.priceWeekly — accommodationIndex.js's own null-safe
// week/month-normalized figure (never a guess for an unrecognized duration
// like "termly") — so a residence with no comparable weekly figure honestly
// shows "—" rather than a fabricated verdict. A residence over budget is
// labeled, never dropped from the table — this is a planning signal, not a
// filter.
export default function CompareResidencesTable({ residences, status = "ready", budget = null }) {
  const hasBudget = Number(budget) > 0;

  return (
    <section className="sp-section" aria-labelledby="sp-compare-heading">
      <div className="sp-section-head">
        <h2 id="sp-compare-heading" className="sp-section-title">Compare Residences</h2>
        {hasBudget && <p className="sp-section-sub">Your weekly budget: £{budget}</p>}
      </div>
      {status !== "ready" ? (
        <div className="sp-building-note">Comparison will appear once recommendations are ready.</div>
      ) : (
      <div className="sp-compare-scroll">
        <table className="sp-compare-table">
          <thead>
            <tr>
              <th>Residence</th>
              <th>Distance</th>
              <th>Walking Time</th>
              <th>Price</th>
              <th>Room Type</th>
              <th>Rating</th>
              <th>Match Score</th>
              {hasBudget && <th>Budget Fit</th>}
            </tr>
          </thead>
          <tbody>
            {residences.map((r) => {
              const weekly = r.priceWeekly;
              const fits = Number.isFinite(weekly) ? weekly <= Number(budget) : null;
              return (
                <tr key={r.id}>
                  <td className="sp-compare-name">{r.name}</td>
                  <td>{r.distanceKm} km</td>
                  <td>{r.walkingMinutes} min</td>
                  <td>{r.price.currency}{r.price.amount}/{r.price.duration}</td>
                  <td>{r.roomType}</td>
                  <td>{r.rating.overall} ★</td>
                  <td>{r.matchScore}%</td>
                  {hasBudget && (
                    <td>
                      {fits == null ? (
                        "—"
                      ) : fits ? (
                        // Never render `weekly` (a derived weekly-equivalent
                        // used only to determine budget fit) as if it were a
                        // real price — a monthly-priced residence has no
                        // £X/week figure Amber ever actually quoted. The real
                        // Price column already shows the true source
                        // amount+duration; this just confirms it fits.
                        <span className="sp-budget-fit sp-budget-fit--ok"><Check size={13} /> Within budget</span>
                      ) : (
                        <span className="sp-budget-fit sp-budget-fit--over"><TriangleAlert size={13} /> Above budget</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
}
