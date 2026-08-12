import React from "react";
import { Target, Wrench, CheckCircle2, Circle, Plus, Code2, Brain, DoorOpen, Map } from "lucide-react";

// Section 9 (Milestone 8) — Career Readiness & Hiring Path. The final,
// active stage of the Housing-to-Hiring journey this milestone builds:
// bridges Milestone 6's career recommendations + Milestone 7's salary
// guidance into practical "what should I do to become ready" guidance.
//
// Deliberately connected, not a disconnected system: `careers` is the SAME
// array DegreeCareerSection.js already renders — each career object here
// already carries `readiness` (api/_lib/careerReadinessResolver.js +
// api/_lib/careerReadiness.json) alongside its existing `salary` (Milestone
// 7) and skill-match fields (Milestone 6). No second fetch, no independent
// skill vocabulary — `readiness.essentialSkills`/`recommendedSkills` come
// straight from api/_lib/careers.json's requiredSkills/preferredSkills, and
// `alreadyCoveredSkills`/`skillsToDevelop` are passed through unchanged from
// Milestone 6's own skill matching.
//
// Kept compact per the plan: only the top-ranked ("strongest") career gets
// the full readiness breakdown — the other 2-4 recommended careers keep
// their existing concise cards in DegreeCareerSection.js. This is guidance,
// never framed as a hiring guarantee or a probability score (no "82% ready").
const MATCH_BADGE_CLASS = {
  "Strong Match": "sp-career-badge--strong",
  "Good Match": "sp-career-badge--good",
  "Possible Path": "sp-career-badge--possible",
};

const INTERVIEW_AREA_LABELS = [
  ["technical", "Technical"],
  ["practical", "Practical"],
  ["behavioral", "Behavioral"],
];

export default function CareerReadinessSection({ careers = [] }) {
  const primaryCareer = careers[0] || null;

  return (
    <section className="sp-section" aria-labelledby="sp-hiring-heading">
      <div className="sp-section-head">
        <h2 id="sp-hiring-heading" className="sp-section-title"><Target size={18} /> Your Hiring Path</h2>
        <p className="sp-section-sub">Practical preparation guidance for your strongest career match — not a guarantee of an interview or a job offer.</p>
      </div>

      {!primaryCareer ? (
        <div className="sp-degree-block">
          <p className="sp-degree-pending">Add a degree above to see career-specific hiring preparation guidance.</p>
        </div>
      ) : (
        <>
          <div className="sp-degree-block">
            <p className="sp-hiring-primary-label">For your strongest career match</p>
            <div className="sp-hiring-primary-head">
              <p className="sp-degree-name">{primaryCareer.title}</p>
              <span className={`sp-career-badge ${MATCH_BADGE_CLASS[primaryCareer.matchLabel] || ""}`}>{primaryCareer.matchLabel}</span>
            </div>
          </div>

          {primaryCareer.readiness?.available ? (
            <ReadinessDetail readiness={primaryCareer.readiness} />
          ) : (
            <div className="sp-degree-block">
              <p className="sp-degree-pending">{primaryCareer.readiness?.note || "Hiring guidance isn't available for this career yet."}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Trivial, single-use presentational piece — kept inline rather than its own
// file, same precedent as CareerCard/SalaryProgression in DegreeCareerSection.js.
function ReadinessDetail({ readiness }) {
  const {
    essentialSkills, alreadyCoveredSkills, skillsToDevelop,
    portfolioExpectations, projectEvidence, experienceSignals,
    interviewAreas, entryRoutes, preparationSteps,
  } = readiness;

  // Splits skillsToDevelop (already computed by Milestone 6 — never
  // recomputed here) into "essential" gaps (drawn from the career's own
  // requiredSkills) vs "differentiating" gaps (drawn from preferredSkills) —
  // plain string comparison against the two lists this same readiness
  // object already carries, not a new normalization layer.
  const essentialSet = new Set(essentialSkills.map((s) => s.toLowerCase()));
  const priorityGaps = skillsToDevelop.filter((s) => essentialSet.has(s.toLowerCase()));
  const differentiatingGaps = skillsToDevelop.filter((s) => !essentialSet.has(s.toLowerCase()));

  return (
    <>
      <div className="sp-degree-block">
        <h3 className="sp-degree-subhead"><Wrench size={16} /> Skills to Develop</h3>
        {alreadyCoveredSkills.length > 0 && (
          <div className="sp-career-skill-group">
            <p className="sp-career-skill-label">Covered by your degree</p>
            <ul className="sp-career-skill-list">
              {alreadyCoveredSkills.map((skill) => (
                <li key={skill} className="sp-career-skill sp-career-skill--have"><CheckCircle2 size={13} /> {skill}</li>
              ))}
            </ul>
          </div>
        )}
        {priorityGaps.length > 0 && (
          <div className="sp-career-skill-group">
            <p className="sp-career-skill-label">Priority skills to develop</p>
            <ul className="sp-career-skill-list">
              {priorityGaps.map((skill) => (
                <li key={skill} className="sp-career-skill sp-career-skill--develop"><Circle size={13} /> {skill}</li>
              ))}
            </ul>
          </div>
        )}
        {differentiatingGaps.length > 0 && (
          <div className="sp-career-skill-group">
            <p className="sp-career-skill-label">Differentiating skills</p>
            <ul className="sp-career-skill-list">
              {differentiatingGaps.map((skill) => (
                <li key={skill} className="sp-career-skill sp-career-skill--extra"><Plus size={13} /> {skill}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="sp-degree-block">
        <h3 className="sp-degree-subhead"><Code2 size={16} /> Portfolio Evidence</h3>
        <p className="sp-degree-note sp-career-intro">Useful evidence includes:</p>
        <ul className="sp-hiring-list">
          {projectEvidence.map((item) => <li key={item}>{item}</li>)}
        </ul>
        {portfolioExpectations.length > 0 && (
          <p className="sp-hiring-subnote">General expectations: {portfolioExpectations.join(" · ")}</p>
        )}
        {experienceSignals.length > 0 && (
          <>
            <p className="sp-hiring-subnote">Signals that can support your readiness:</p>
            <div className="sp-skill-chip-row">
              {experienceSignals.map((signal) => (
                <span key={signal} className="sp-skill-chip sp-skill-chip--muted">{signal}</span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="sp-degree-block">
        <h3 className="sp-degree-subhead"><Brain size={16} /> Interview Preparation</h3>
        <p className="sp-degree-note sp-career-intro">Common preparation areas include:</p>
        <div className="sp-interview-grid">
          {INTERVIEW_AREA_LABELS.map(([key, label]) => (
            interviewAreas?.[key]?.length > 0 && (
              <div key={key} className="sp-interview-group">
                <p className="sp-career-skill-label">{label}</p>
                <ul className="sp-hiring-list">
                  {interviewAreas[key].map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            )
          ))}
        </div>
      </div>

      <div className="sp-degree-block">
        <h3 className="sp-degree-subhead"><DoorOpen size={16} /> Typical Entry Routes</h3>
        <p className="sp-degree-note sp-career-intro">Common entry routes include:</p>
        <ul className="sp-hiring-list">
          {entryRoutes.map((item) => <li key={item}>{item}</li>)}
        </ul>
      </div>

      <div className="sp-degree-block">
        <h3 className="sp-degree-subhead"><Map size={16} /> Suggested Preparation Path</h3>
        <ol className="sp-hiring-steps">
          {preparationSteps.map((step) => <li key={step}>{step}</li>)}
        </ol>
      </div>
    </>
  );
}
