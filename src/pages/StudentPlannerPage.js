import React, { useState } from "react";
import { Home, GraduationCap, Wallet, BookOpen, Sparkles, Briefcase, TrendingUp, Award, Presentation } from "lucide-react";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import UniversityOverview from "../components/planner/UniversityOverview";
import UniversityAutocomplete from "../components/planner/UniversityAutocomplete";
import DegreeAutocomplete from "../components/planner/DegreeAutocomplete";
import { resolveUniversity } from "../lib/universityResolver";
import { resolveDegree } from "../lib/degreeResolver";
import RecommendedResidences from "../components/planner/RecommendedResidences";
import PlannerMap from "../components/planner/PlannerMap";
import CompareResidencesTable from "../components/planner/CompareResidencesTable";
import LivingExpenses from "../components/planner/LivingExpenses";
import DegreeCareerSection from "../components/planner/DegreeCareerSection";
import CareerReadinessSection from "../components/planner/CareerReadinessSection";
import { buildMockPlannerResult } from "../lib/plannerMock";
import "./StudentPlannerPage.css";

const ROOM_TYPE_OPTIONS = ["Studio", "Ensuite", "Shared Twin", "Private Studio"];

// `upcoming: true` marks stages the product vision names but hasn't built
// yet. As of Milestone 8 (Career Readiness & Hiring Path), every stage
// through "Hiring" is real, deterministic, curated data — Career (Milestone
// 6, api/_lib/careers.json), Salary (Milestone 7, api/_lib/salaries.json)
// and now Hiring readiness (Milestone 8, api/_lib/careerReadiness.json).
// Nothing is muted anymore; "Hiring" is the final active stage. This still
// never implies IVYHUTS guarantees a job — see CareerReadinessSection.js's
// own language ("not a guarantee of an interview or a job offer").
const JOURNEY_STEPS = [
  { key: "housing", label: "Housing", Icon: Home },
  { key: "university", label: "University", Icon: GraduationCap },
  { key: "living-costs", label: "Living Costs", Icon: Wallet },
  { key: "degree", label: "Degree", Icon: BookOpen },
  { key: "skills", label: "Skills", Icon: Sparkles },
  { key: "career", label: "Career", Icon: Briefcase },
  { key: "salary", label: "Salary", Icon: TrendingUp },
  { key: "hiring", label: "Hiring", Icon: Award },
];

// Section 1 — trivial, kept inline rather than as its own file.
function JourneyStepHeader() {
  return (
    <div className="sp-journey-row" aria-label="Housing to Hiring journey">
      {JOURNEY_STEPS.map(({ key, label, Icon, upcoming }, i) => (
        <React.Fragment key={key}>
          <div className={`sp-journey-step${upcoming ? " sp-journey-step--upcoming" : ""}`}>
            <span className="sp-journey-icon"><Icon size={16} /></span>
            <span>{label}</span>
          </div>
          {i < JOURNEY_STEPS.length - 1 && <span className="sp-journey-arrow">→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

// Section 8 (Milestone 9) — real PPT generation. Sends the SAME
// `plannerResult` object already rendered on this page as the request body
// to /api/student-planner-ppt — ONE request, no second /api/student-planner
// call, no Amber, no independent re-calculation of career/salary/readiness.
// The endpoint is purely a different presentation of this exact data (see
// api/student-planner-ppt.js + api/_lib/pptBuilder.js's own header comments).
function PptCtaSection({ plannerResult }) {
  const [status, setStatus] = useState("idle"); // "idle" | "loading" | "success" | "error"

  const handleDownload = async () => {
    if (status === "loading") return; // guards against a duplicate request while one is already in flight
    setStatus("loading");
    try {
      const res = await fetch("/api/student-planner-ppt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(plannerResult),
      });
      if (!res.ok) throw new Error("generation_failed");
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "ivyhuts-student-plan.pptx";

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setStatus("success");
      setTimeout(() => setStatus("idle"), 3000);
    } catch (err) {
      // Never expose stack traces / internal errors to the student — a
      // single generic message, same philosophy as the rest of this page.
      setStatus("error");
    }
  };

  const buttonLabel = {
    idle: "Download My Student Plan",
    loading: "Generating Your Plan…",
    success: "Downloaded!",
    error: "Download My Student Plan",
  }[status];

  return (
    <section className="sp-section sp-ppt-section" aria-labelledby="sp-ppt-heading">
      <div className="sp-ppt-card">
        <div>
          <h2 id="sp-ppt-heading" className="sp-section-title"><Presentation size={18} /> Take Your Plan Anywhere</h2>
          <p className="sp-section-sub">Export this entire report as an editable PowerPoint presentation.</p>
          {status === "error" && <p className="sp-ppt-error">Unable to generate your plan. Please try again.</p>}
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={handleDownload} disabled={status === "loading"}>
          {buttonLabel}
        </button>
      </div>
    </section>
  );
}

export default function StudentPlannerPage() {
  const [step, setStep] = useState("form"); // "form" | "results"
  const [studentInput, setStudentInput] = useState({
    university: "", degree: "", country: "", city: "",
    specialization: "", currentYear: "", graduationYear: "",
    budget: "", accommodationPreference: "",
  });
  const [errors, setErrors] = useState({});
  // The canonical record from src/data/universities.json once the student
  // selects a suggestion — {id, name, city, country, latitude, longitude} —
  // or null for free text (the unchanged Milestone 1/2 fallback path).
  const [resolvedUniversity, setResolvedUniversity] = useState(null);
  // The canonical { id, name } from src/data/degreeSuggestions.json once the
  // student selects a suggestion (Milestone 5) — or null for free text,
  // same fallback shape as resolvedUniversity above.
  const [resolvedDegree, setResolvedDegree] = useState(null);
  const [plannerResult, setPlannerResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // "ready" | "building" — whether real accommodation-index residences were
  // available. Independent of `step`: the rest of the plannerResult (mock,
  // unchanged from Milestone 1) always renders; this only gates the three
  // residence-consuming sections.
  const [residencesStatus, setResidencesStatus] = useState("ready");

  const set = (field, value) => {
    setStudentInput((d) => ({ ...d, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const selectUniversity = (uni) => {
    setResolvedUniversity(uni);
    // Do not force the student to manually enter city/country when they're
    // derivable from the selected university — auto-fill and (via
    // UniversityAutocomplete's read-only display) lock them.
    setStudentInput((d) => ({ ...d, university: uni.name, city: uni.city, country: uni.country }));
    setErrors((e) => ({ ...e, university: undefined, city: undefined, country: undefined }));
  };

  const clearUniversity = () => {
    setResolvedUniversity(null);
    setStudentInput((d) => ({ ...d, university: "", city: "", country: "" }));
  };

  const selectDegree = (degree) => {
    setResolvedDegree(degree);
    setStudentInput((d) => ({ ...d, degree: degree.name }));
    setErrors((e) => ({ ...e, degree: undefined }));
  };

  const clearDegree = () => {
    setResolvedDegree(null);
    setStudentInput((d) => ({ ...d, degree: "" }));
  };

  const validate = () => {
    const e = {};
    if (!studentInput.university.trim()) e.university = "Please enter your university.";
    if (!studentInput.degree.trim()) e.degree = "Please enter your degree.";
    if (!studentInput.country.trim()) e.country = "Please enter your country.";
    if (!studentInput.city.trim()) e.city = "Please enter your city.";
    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length) { setErrors(errs); return; }

    setSubmitting(true);

    // If the student typed free text without selecting a suggestion, try one
    // courtesy exact-match resolve (e.g. they typed the exact canonical name)
    // before falling back to manual city/country — same exact/alias-only
    // resolver the autocomplete itself uses, never a fuzzy guess.
    const effectiveUniversity = resolvedUniversity || resolveUniversity(studentInput.university);
    // Same courtesy pattern for degree (Milestone 5) — the authoritative
    // resolve still happens server-side against the full dataset.
    const effectiveDegree = resolvedDegree || resolveDegree(studentInput.degree);

    // Salary/hiring/job-market data stay out of scope this milestone
    // (Milestone 6 plan items 13-14). The university section uses the real
    // resolved record when one exists; degree/livingExpenses/residences/
    // careers all get replaced by the real API response below when it
    // succeeds. See src/lib/plannerMock.js and api/_lib/accommodationIndex.js.
    const result = buildMockPlannerResult(studentInput, effectiveUniversity);

    try {
      const params = new URLSearchParams({ city: studentInput.city, source: "student-planner-page" });
      if (studentInput.country) params.set("country", studentInput.country);
      if (effectiveUniversity) params.set("universityId", effectiveUniversity.id);
      if (studentInput.budget) params.set("budget", studentInput.budget);
      if (studentInput.accommodationPreference) params.set("accommodationPreference", studentInput.accommodationPreference);
      if (effectiveDegree) params.set("degreeId", effectiveDegree.id);
      if (studentInput.degree) params.set("degree", studentInput.degree);
      if (studentInput.specialization) params.set("specialization", studentInput.specialization);
      const res = await fetch(`/api/student-planner?${params.toString()}`);
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok && body.status === "ready" && Array.isArray(body.residences) && body.residences.length) {
        result.residences = body.residences;
        result.comparison = body.comparison || body.residences;
        setResidencesStatus("ready");
      } else {
        setResidencesStatus("building");
      }
      // degree (Milestone 5) comes from the SAME single planner request —
      // no second fetch. Always replaces the mock/pending placeholder when
      // the API responded at all, whether resolved or a controlled
      // "unresolved" shape (never fabricated skills either way).
      if (res.ok && body?.ok && body.degree) {
        result.degree = body.degree;
      }
      // careers (Milestone 6) comes from the SAME single planner request as
      // degree above — no second fetch, no client-side career generation.
      // Always replaces the mock/pending empty array when the API responded
      // at all (`body.careers` is always an array, possibly empty, never
      // undefined) — see api/_lib/careerResolver.js.
      if (res.ok && body?.ok && Array.isArray(body.careers)) {
        result.careers = body.careers;
      }
      // livingExpenses (Milestone 4) comes from the SAME single planner
      // request as residences/comparison above — no second fetch. Always
      // replaces the mock figure when the API responded at all (even
      // status:"building"), since costOfLiving.js's curated city data is
      // independent of whether a real residence was found.
      if (res.ok && body?.ok && body.livingExpenses) {
        result.livingExpenses = body.livingExpenses;
      }
    } catch (err) {
      // Endpoint unreachable (e.g. plain `react-scripts start` instead of
      // `vercel dev`, or a network hiccup) — degrade gracefully, never crash
      // the results page over a missing real-data section.
      setResidencesStatus("building");
    }

    setPlannerResult(result);
    setStep("results");
    setSubmitting(false);
    window.scrollTo(0, 0);
  };

  const editDetails = () => setStep("form");

  return (
    <div className="sp-page">
      <SiteNavbar />

      <main className="sp-main">
        {step === "form" ? (
          <div className="sp-hero">
            <p className="sp-eyebrow">Housing to Hiring</p>
            <h1 className="sp-hero-title">Plan Your Journey from Housing to Hiring</h1>
            <p className="sp-hero-sub">
              Tell us about your university, degree and budget. We'll help you understand where to
              live, what it may cost, and where your degree can take you.
            </p>

            <form className="sp-form-card" onSubmit={handleSubmit} noValidate>
              <div className="sp-form-row">
                <UniversityAutocomplete
                  value={studentInput.university}
                  onChange={(text) => set("university", text)}
                  resolved={resolvedUniversity}
                  onSelect={selectUniversity}
                  onClear={clearUniversity}
                  error={errors.university}
                />
                <DegreeAutocomplete
                  value={studentInput.degree}
                  onChange={(text) => set("degree", text)}
                  resolved={resolvedDegree}
                  onSelect={selectDegree}
                  onClear={clearDegree}
                  error={errors.degree}
                />
              </div>

              <div className="sp-form-row">
                <div className="sp-field">
                  <label>Country <span className="sp-req">*</span></label>
                  <input
                    value={studentInput.country}
                    onChange={(e) => set("country", e.target.value)}
                    readOnly={!!resolvedUniversity}
                    maxLength={60}
                    placeholder="e.g. United Kingdom"
                  />
                  {errors.country && <span className="sp-field-err">{errors.country}</span>}
                </div>
                <div className="sp-field">
                  <label>City <span className="sp-req">*</span></label>
                  <input
                    value={studentInput.city}
                    onChange={(e) => set("city", e.target.value)}
                    readOnly={!!resolvedUniversity}
                    maxLength={60}
                    placeholder="e.g. Manchester"
                  />
                  {errors.city && <span className="sp-field-err">{errors.city}</span>}
                </div>
              </div>

              <div className="sp-form-row">
                <div className="sp-field">
                  <label>Specialization <span className="sp-opt">(optional)</span></label>
                  <input value={studentInput.specialization} onChange={(e) => set("specialization", e.target.value)} maxLength={120} placeholder="e.g. Artificial Intelligence" />
                </div>
                <div className="sp-field">
                  <label>Preferred Accommodation <span className="sp-opt">(optional)</span></label>
                  <select value={studentInput.accommodationPreference} onChange={(e) => set("accommodationPreference", e.target.value)}>
                    <option value="">No preference</option>
                    {ROOM_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>

              <div className="sp-form-row sp-form-row-3">
                <div className="sp-field">
                  <label>Current Year <span className="sp-opt">(optional)</span></label>
                  <input value={studentInput.currentYear} onChange={(e) => set("currentYear", e.target.value)} maxLength={20} placeholder="e.g. Year 2" />
                </div>
                <div className="sp-field">
                  <label>Graduation Year <span className="sp-opt">(optional)</span></label>
                  <input value={studentInput.graduationYear} onChange={(e) => set("graduationYear", e.target.value)} maxLength={20} placeholder="e.g. 2027" />
                </div>
                <div className="sp-field">
                  <label>Weekly Budget <span className="sp-opt">(optional)</span></label>
                  <input type="number" min="0" value={studentInput.budget} onChange={(e) => set("budget", e.target.value)} placeholder="e.g. 220" />
                </div>
              </div>

              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={submitting}>
                {submitting ? "Building your plan…" : "Build My Student Plan"}
              </button>
            </form>
          </div>
        ) : (
          <div className="sp-results">
            <JourneyStepHeader />

            <div className="sp-results-head">
              <h1 className="sp-results-title">Your Student Plan for {plannerResult.student.university}</h1>
              <button type="button" className="btn btn-ghost" onClick={editDetails}>Edit My Details</button>
            </div>

            <UniversityOverview university={plannerResult.university} />
            <RecommendedResidences residences={plannerResult.residences} city={plannerResult.student.city} status={residencesStatus} />
            <PlannerMap university={plannerResult.university} residences={plannerResult.residences} status={residencesStatus} />
            <CompareResidencesTable residences={plannerResult.comparison} status={residencesStatus} budget={plannerResult.student.budget} />
            <LivingExpenses livingExpenses={plannerResult.livingExpenses} residencesStatus={residencesStatus} />
            <DegreeCareerSection degree={plannerResult.degree} careers={plannerResult.careers} />
            <CareerReadinessSection careers={plannerResult.careers} />
            <PptCtaSection plannerResult={plannerResult} />
          </div>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
