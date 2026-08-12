import React from "react";
import { Info } from "lucide-react";

// Section 6 (Milestone 4) — real city-level cost-of-living estimate from
// api/_lib/costOfLiving.js via /api/student-planner's livingExpenses field
// (see StudentPlannerPage.js's handleSubmit). Labels follow the data
// contract's actual field names rather than paraphrasing them, and the
// "estimate" framing (meta.note) is shown, not hidden — these are planning
// figures, not exact financial predictions (item 14).
const SCENARIO_LABELS = { budget: "Budget", average: "Average", comfortable: "Comfortable" };

export default function LivingExpenses({ livingExpenses, residencesStatus = "ready" }) {
  const { accommodation, food, transport, utilities, personal, other, totalMonthly, totalAnnual, scenarios, currency, meta } = livingExpenses;
  const rows = [
    { label: "Accommodation", value: accommodation },
    { label: "Food", value: food },
    { label: "Transport", value: transport },
    { label: "Utilities", value: utilities },
    { label: "Personal", value: personal },
    { label: "Other", value: other },
  ];

  return (
    <section className="sp-section" aria-labelledby="sp-expenses-heading">
      <div className="sp-section-head">
        <h2 id="sp-expenses-heading" className="sp-section-title">Estimated Living Expenses</h2>
        <p className="sp-section-sub">A city-level monthly estimate — not exact financial advice.</p>
      </div>

      <div className="sp-expenses-card">
        <h3 className="sp-expenses-subhead">Estimated Monthly Cost</h3>
        {rows.map((row) => (
          <div key={row.label} className="sp-expenses-row">
            <span>{row.label}</span>
            <span>{row.value != null ? `${currency}${row.value}` : "—"}</span>
          </div>
        ))}
        <div className="sp-expenses-row sp-expenses-total">
          <span>Estimated total / month</span>
          <span>{totalMonthly != null ? `${currency}${totalMonthly}` : "—"}</span>
        </div>

        {accommodation == null && (
          <p className="sp-expenses-pending">
            {residencesStatus === "ready"
              ? "Accommodation cost isn't available for your top residence yet, so the monthly/annual total is shown as pending."
              : "Once your recommended residences are ready, accommodation cost will complete this total."}
          </p>
        )}

        {totalAnnual != null && (
          <div className="sp-expenses-annual">
            <span className="sp-expenses-annual-label">Estimated Annual Cost</span>
            <span className="sp-expenses-annual-value">{currency}{totalAnnual.toLocaleString()}/year</span>
          </div>
        )}

        {scenarios && (
          <div className="sp-expenses-scenarios">
            {Object.entries(SCENARIO_LABELS).map(([key, label]) => (
              <div key={key} className={`sp-scenario-tile sp-scenario-tile--${key}`}>
                <span className="sp-scenario-label">{label}</span>
                <span className="sp-scenario-value">{currency}{scenarios[key]}<span className="sp-scenario-unit">/mo</span></span>
              </div>
            ))}
          </div>
        )}

        {meta?.note && (
          <p className="sp-expenses-note"><Info size={13} /> {meta.note}</p>
        )}
      </div>
    </section>
  );
}
