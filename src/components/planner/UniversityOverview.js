import React from "react";
import { GraduationCap, CheckCircle } from "lucide-react";

// Section 2 — kept concise on purpose: name, location, one summary line,
// and a short list of key facts. Not a full university profile page.
export default function UniversityOverview({ university }) {
  return (
    <section className="sp-section" aria-labelledby="sp-university-heading">
      <div className="sp-university-card">
        <div className="sp-university-icon"><GraduationCap size={22} /></div>
        <div>
          <h2 id="sp-university-heading" className="sp-section-title">{university.name || "Your University"}</h2>
          <p className="sp-university-location">{[university.city, university.country].filter(Boolean).join(", ")}</p>
          <p className="sp-university-summary">{university.summary}</p>
          {university.keyFacts?.length > 0 && (
            <ul className="sp-university-facts">
              {university.keyFacts.map((fact) => (
                <li key={fact}><CheckCircle size={14} /> {fact}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
