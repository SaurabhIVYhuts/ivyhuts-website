import React from "react";
import { BookOpen, Wrench, Settings, Rocket, Info, Briefcase, CheckCircle2, Circle, TrendingUp } from "lucide-react";

// Section 7 (Milestone 5) — Degree & Skills. Evolved in Milestone 6 into
// "Your Degree & Career Path" (career-path guidance backed by real, curated,
// deterministically-ranked data — see api/_lib/careers.json +
// api/_lib/careerResolver.js), and further in Milestone 7 with an
// "Estimated Salary" section per career.id + the selected university's
// country — see api/_lib/salaries.json + api/_lib/salaryResolver.js. Still
// no hiring/job-market data, no AI-generated content — those remain out of
// scope (Milestone 7 plan item 30).
//
// `degree` and `careers` both come from /api/student-planner's response
// (api/_lib/degreeResolver.js + api/_lib/degrees.json, and
// api/_lib/careerResolver.js + api/_lib/careers.json — each career object
// also carries a `salary` field from api/_lib/salaryResolver.js) via
// StudentPlannerPage.js, or src/lib/plannerMock.js's controlled placeholders
// before that response arrives. Three degree states, all handled explicitly
// — never a blank or broken-looking section:
//   "pending"    — request in flight / API unreachable, nothing fabricated
//   "unresolved" — API answered, but this degree isn't in the IVYHUTS
//                  curated dataset yet — shows the entered name, no skills
//   "ready"      — real curated data, the normal case; `careers` (possibly
//                  an empty array — never fabricated) is only ever rendered
//                  alongside a "ready" degree. Each career's `salary` is
//                  independently either `{available:true, ...}` or a
//                  controlled `{available:false}` — never fabricated either.
export default function DegreeCareerSection({ degree, careers = [] }) {
  const { name, status, summary, category, coreSkills, technicalAreas, specializationPaths, specialization, specializationNote } = degree;

  // "Skills to Develop" rollup (Milestone 6 plan item 18): the union of
  // skillsToDevelop across the top career matches, deduplicated by exact
  // text (career-level dedup already happened in careerResolver.js) and
  // capped so the section stays a quick scan, not a second skill dump.
  const skillsToDevelopSummary = [];
  const seenSkills = new Set();
  for (const career of careers) {
    for (const skill of career.skillsToDevelop || []) {
      const key = skill.toLowerCase();
      if (seenSkills.has(key)) continue;
      seenSkills.add(key);
      skillsToDevelopSummary.push(skill);
      if (skillsToDevelopSummary.length >= 8) break;
    }
    if (skillsToDevelopSummary.length >= 8) break;
  }

  return (
    <section className="sp-section" aria-labelledby="sp-degree-heading">
      <div className="sp-section-head">
        <h2 id="sp-degree-heading" className="sp-section-title">Your Degree &amp; Career Path</h2>
        <p className="sp-section-sub">What this degree commonly develops, and where it can potentially lead — general guidance, not a specific university's curriculum or a guarantee.</p>
      </div>

      <div className="sp-degree-block">
        <h3 className="sp-degree-subhead"><BookOpen size={16} /> Your Degree</h3>
        <p className="sp-degree-name">{name || "Your Degree"}</p>

        {status === "ready" && (
          <>
            {category && <p className="sp-degree-category">{category}</p>}
            <p className="sp-degree-summary">{summary}</p>
          </>
        )}
        {status === "unresolved" && (
          <p className="sp-degree-pending">
            {name
              ? `We don't yet have structured guidance for "${name}" in the IVYHUTS curated dataset.`
              : "Enter a degree above to see its skills and specialization paths."}
          </p>
        )}
        {status === "pending" && (
          <p className="sp-degree-pending">Still preparing your degree guidance…</p>
        )}
      </div>

      {status === "ready" && (
        <>
          <div className="sp-degree-block">
            <h3 className="sp-degree-subhead"><Wrench size={16} /> Core Skills</h3>
            <div className="sp-skill-chip-row">
              {coreSkills.map((skill) => (
                <span key={skill} className="sp-skill-chip">{skill}</span>
              ))}
            </div>
          </div>

          <div className="sp-degree-block">
            <h3 className="sp-degree-subhead"><Settings size={16} /> Technical Areas</h3>
            <div className="sp-skill-chip-row">
              {technicalAreas.map((area) => (
                <span key={area} className="sp-skill-chip sp-skill-chip--muted">{area}</span>
              ))}
            </div>
          </div>

          <div className="sp-degree-block">
            <h3 className="sp-degree-subhead"><Rocket size={16} /> Specialization Paths</h3>
            <div className="sp-skill-chip-row">
              {specializationPaths.map((path) => (
                <span
                  key={path.id}
                  className={`sp-skill-chip sp-skill-chip--outline${specialization?.id === path.id ? " sp-skill-chip--active" : ""}`}
                >
                  {path.name}
                </span>
              ))}
            </div>

            {specialization && (
              <div className="sp-specialization-emphasis">
                <p className="sp-specialization-emphasis-label">Emphasis for {specialization.name}</p>
                <div className="sp-skill-chip-row">
                  {specialization.emphasisSkills.map((skill) => (
                    <span key={skill} className="sp-skill-chip sp-skill-chip--active">{skill}</span>
                  ))}
                </div>
              </div>
            )}
            {specializationNote && (
              <p className="sp-degree-note"><Info size={13} /> {specializationNote}</p>
            )}
          </div>

          <div className="sp-degree-block">
            <h3 className="sp-degree-subhead"><Briefcase size={16} /> Where Your Degree Can Take You</h3>
            {careers.length > 0 ? (
              <>
                <p className="sp-degree-note sp-career-intro">
                  Potential career paths based on your degree{specialization ? ` and ${specialization.name} specialization` : ""}. This is guidance, not a guaranteed outcome.
                </p>
                <div className="sp-career-grid">
                  {careers.map((career, i) => (
                    <CareerCard key={career.id} career={career} rank={i + 1} />
                  ))}
                </div>
              </>
            ) : (
              <p className="sp-degree-pending">
                We don't yet have curated career guidance for this degree{specialization ? " and specialization combination" : ""} — more career paths are being added over time.
              </p>
            )}
          </div>

          {careers.length > 0 && (
            <div className="sp-degree-block">
              <h3 className="sp-degree-subhead"><TrendingUp size={16} /> Estimated Salary</h3>
              <p className="sp-degree-note sp-career-intro">
                Indicative career progression for your strongest match, {careers[0].title}
                {careers[0].salary?.available ? ` in ${careers[0].salary.country}` : ""}. Estimates only — not a guaranteed salary or offer.
              </p>
              <SalaryProgression career={careers[0]} />
            </div>
          )}

          {skillsToDevelopSummary.length > 0 && (
            <div className="sp-degree-block">
              <h3 className="sp-degree-subhead"><Rocket size={16} /> Skills to Develop</h3>
              <p className="sp-degree-note sp-career-intro">For your strongest career matches, these are the skills worth building next.</p>
              <div className="sp-skill-chip-row">
                {skillsToDevelopSummary.map((skill) => (
                  <span key={skill} className="sp-skill-chip sp-skill-chip--outline">{skill}</span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const MATCH_BADGE_CLASS = {
  "Strong Match": "sp-career-badge--strong",
  "Good Match": "sp-career-badge--good",
  "Possible Path": "sp-career-badge--possible",
};

const EXPERIENCE_LEVEL_LABELS = [
  ["entryLevel", "Entry Level"],
  ["earlyCareer", "Early Career"],
  ["midCareer", "Mid Career"],
  ["experienced", "Experienced"],
];

const SALARY_UNAVAILABLE_TEXT = "Salary guidance isn't available for this career/location yet.";

// Deliberately rounded to the nearest thousand ("£28k") rather than the
// dataset's raw integers (plan item 31 — no false precision: a curated
// planning range was never meant to read like a payslip figure).
function formatThousands(currency, amount) {
  if (!Number.isFinite(amount)) return "—";
  return `${currency}${Math.round(amount / 1000)}k`;
}

function formatSalaryRange(currency, range) {
  if (!range) return null;
  return `${formatThousands(currency, range.min)}–${formatThousands(currency, range.max)}`;
}

// Trivial, single-use presentational pieces — kept inline rather than their
// own files, same precedent as JourneyStepHeader/PptCtaSection in
// StudentPlannerPage.js.
function CareerCard({ career, rank }) {
  const { title, category, summary, matchLabel, alreadyHaveSkills, skillsToDevelop, salary } = career;
  return (
    <article className="sp-career-card" aria-label={`${title}, ${matchLabel}`}>
      <div className="sp-career-card-head">
        <span className="sp-career-rank">{rank}</span>
        <div>
          <h4 className="sp-career-title">{title}</h4>
          {category && <p className="sp-career-category">{category}</p>}
        </div>
      </div>
      <span className={`sp-career-badge ${MATCH_BADGE_CLASS[matchLabel] || ""}`}>{matchLabel}</span>
      {summary && <p className="sp-career-summary">{summary}</p>}

      {alreadyHaveSkills.length > 0 && (
        <div className="sp-career-skill-group">
          <p className="sp-career-skill-label">Skills covered by your degree</p>
          <ul className="sp-career-skill-list">
            {alreadyHaveSkills.map((skill) => (
              <li key={skill} className="sp-career-skill sp-career-skill--have">
                <CheckCircle2 size={13} /> {skill}
              </li>
            ))}
          </ul>
        </div>
      )}

      {skillsToDevelop.length > 0 && (
        <div className="sp-career-skill-group">
          <p className="sp-career-skill-label">Develop next</p>
          <ul className="sp-career-skill-list">
            {skillsToDevelop.map((skill) => (
              <li key={skill} className="sp-career-skill sp-career-skill--develop">
                <Circle size={13} /> {skill}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Compact per-card salary line (plan item 11) — the full stage-by-stage
          progression only ever renders once, for the top match, below (see
          SalaryProgression). */}
      <div className="sp-career-salary">
        {salary?.available ? (
          <>
            <p className="sp-career-skill-label">Estimated entry-level, {salary.country}</p>
            <p className="sp-career-salary-value">{formatSalaryRange(salary.currency, salary.ranges.entryLevel)}</p>
          </>
        ) : (
          <p className="sp-career-salary-unavailable">{SALARY_UNAVAILABLE_TEXT}</p>
        )}
      </div>
    </article>
  );
}

// Indicative progression (Entry -> Early -> Mid -> Experienced) for a single
// career — rendered once, for the top-ranked match only (plan item 11: this
// is a decision-support page, not a salary database). Never implies
// progression is automatic or guaranteed (plan item 12).
function SalaryProgression({ career }) {
  const { salary } = career;
  if (!salary?.available) {
    return <p className="sp-career-salary-unavailable">{SALARY_UNAVAILABLE_TEXT}</p>;
  }
  return (
    <>
      <div className="sp-salary-progression">
        {EXPERIENCE_LEVEL_LABELS.map(([key, label], i) => (
          <React.Fragment key={key}>
            <div className="sp-salary-stage">
              <span className="sp-salary-stage-label">{label}</span>
              <span className="sp-salary-stage-value">{formatSalaryRange(salary.currency, salary.ranges[key])}</span>
            </div>
            {i < EXPERIENCE_LEVEL_LABELS.length - 1 && <span className="sp-salary-stage-arrow">→</span>}
          </React.Fragment>
        ))}
      </div>
      <p className="sp-degree-note sp-salary-disclaimer"><Info size={13} /> {salary.note}</p>
    </>
  );
}
