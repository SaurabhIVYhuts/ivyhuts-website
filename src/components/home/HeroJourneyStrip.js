import React from "react";
import { BarChart3, GraduationCap, Users, ArrowRight } from "lucide-react";
import "./HeroJourneyStrip.css";

// The three MAIN journey stages — housing intelligence, mentorship, community.
// Rendered as a single horizontal row (numbered node + headline + short
// description per step), connected by thin arrows. Purely visual
// storytelling: no hover state, no tooltip, no click behaviour.
const STAGES = [
  {
    number: "01",
    title: "Book Accommodation",
    desc: "Real Cost of Living by Our Analytics Teams",
    Icon: BarChart3,
  },
  {
    number: "02",
    title: "Mentorship by IIM Grads",
    desc: "Get guidance, mentorship and practical insights from experienced IIM graduates.",
    Icon: GraduationCap,
  },
  {
    number: "03",
    title: "Exclusive IVYHUTS Community",
    desc: "Right Projects, Right Internship, Right Certifications, Right Job Opportunities",
    Icon: Users,
  },
];

export default function HeroJourneyStrip() {
  return (
    <div className="hero-journey-flow" aria-label="The IvyHuts journey: cost intelligence, mentorship and community">
      <div className="hero-journey-main">
        {STAGES.map((stage, i) => (
          <React.Fragment key={stage.number}>
            <div className="hero-journey-stage">
              <span className="hero-journey-stage-icon">
                <stage.Icon aria-hidden="true" />
                <span className="hero-journey-stage-number">{stage.number}</span>
              </span>
              <span className="hero-journey-stage-title">{stage.title}</span>
              {stage.desc && <span className="hero-journey-stage-desc">{stage.desc}</span>}
            </div>
            {i < STAGES.length - 1 && (
              <span className="hero-journey-connector" aria-hidden="true">
                <ArrowRight />
              </span>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
