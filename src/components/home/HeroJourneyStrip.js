import React from "react";
import { BarChart3, GraduationCap, Users, ArrowRight } from "lucide-react";
import "./HeroJourneyStrip.css";

// The three MAIN journey stages — housing intelligence, mentorship, community.
// Rendered as a single horizontal row (numbered node + headline per step),
// connected by thin arrows. Purely visual storytelling: no hover state, no
// tooltip, no click behaviour.
const STAGES = [
  {
    number: "01",
    title: "Book Accommodation",
    Icon: BarChart3,
  },
  {
    number: "02",
    title: "Mentorship by IIM Grads",
    Icon: GraduationCap,
  },
  {
    number: "03",
    title: "Exclusive IVYHUTS Community",
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
