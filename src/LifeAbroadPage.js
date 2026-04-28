import React, { useState } from "react";
import { Link } from "react-router-dom";
import "./LifeAbroadPage.css";
import SiteFooter from "./SiteFooter";
import SiteNavbar from "./SiteNavbar";

const COUNTRIES = [
  { name: "All", flag: "🌍" },
  { name: "Australia", flag: "🇦🇺" },
  { name: "Canada", flag: "🇨🇦" },
  { name: "USA", flag: "🇺🇸" },
  { name: "UK", flag: "🇬🇧" },
  { name: "Germany", flag: "🇩🇪" },
  { name: "France", flag: "🇫🇷" },
];

const VIDEO_PLACEHOLDERS = [
  {
    country: "UK",
    flag: "🇬🇧",
    title: "Finding Student Accommodation in London on a Budget",
    topic: "Housing Tips",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  },
  {
    country: "Canada",
    flag: "🇨🇦",
    title: "My First Week in Toronto: Arriving as an Int'l Student",
    topic: "Arrival Guide",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
  },
  {
    country: "Australia",
    flag: "🇦🇺",
    title: "En-Suite vs Studio: Which Room Type is Right for You?",
    topic: "Room Guide",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
  },
  {
    country: "UK",
    flag: "🇬🇧",
    title: "What Bills Are Actually Included in UK Student Halls?",
    topic: "Bills & Costs",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
  },
  {
    country: "Germany",
    flag: "🇩🇪",
    title: "Finding a Room in Berlin as a Non-German Speaker",
    topic: "Housing Tips",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  },
  {
    country: "France",
    flag: "🇫🇷",
    title: "Student Accommodation in Paris: What to Expect",
    topic: "Housing Tips",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  },
  {
    country: "Australia",
    flag: "🇦🇺",
    title: "Sydney vs Melbourne: Where Should You Live?",
    topic: "City Guide",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)",
  },
  {
    country: "Canada",
    flag: "🇨🇦",
    title: "Bank Account, SIM and Transport Card: Canada Day 1",
    topic: "Arrival Guide",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)",
  },
  {
    country: "USA",
    flag: "🇺🇸",
    title: "Off-Campus Housing Near Boston Universities: Full Guide",
    topic: "Housing Tips",
    duration: "Coming Soon",
    gradient: "linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)",
  },
];

function LifeAbroadPage() {
  const [activeCountry, setActiveCountry] = useState("All");

  const filtered =
    activeCountry === "All"
      ? VIDEO_PLACEHOLDERS
      : VIDEO_PLACEHOLDERS.filter((v) => v.country === activeCountry);

  return (
    <div className="la-page">
      <SiteNavbar />

      {/* Hero */}
      <main><div className="la-hero">
        <div className="la-hero-inner">
          <p className="la-eyebrow">Real Student Experiences</p>
          <h1>Life Abroad</h1>
          <p className="la-hero-sub">
            Watch real stories from students who made the leap. Housing, jobs, PR, culture and everything in between.
          </p>
          <div className="la-coming-soon-badge">
            Videos dropping soon. Stay tuned!
          </div>
        </div>
      </div>

      {/* Country Filter */}
      <div className="la-filter-bar">
        {COUNTRIES.map((c) => (
          <button
            key={c.name}
            className={`la-filter-btn ${activeCountry === c.name ? "la-filter-btn-active" : ""}`}
            onClick={() => setActiveCountry(c.name)}
          >
            {c.flag} {c.name}
          </button>
        ))}
      </div>

      {/* Video Grid */}
      <div className="la-content">
        <div className="la-grid">
          {filtered.map((video, i) => (
            <div key={i} className="la-video-card">
              <div className="la-thumbnail" style={{ background: video.gradient }}>
                <div className="la-play-btn">▶</div>
                <div className="la-coming-soon">Coming Soon</div>
              </div>
              <div className="la-card-body">
                <div className="la-card-meta">
                  <span className="la-card-flag">{video.flag}</span>
                  <span className="la-card-topic">{video.topic}</span>
                </div>
                <h3 className="la-card-title">{video.title}</h3>
                <span className="la-card-duration">{video.duration}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Submit your story CTA */}
        <div className="la-submit-cta">
          <div className="la-submit-cta-inner">
            <span className="la-submit-icon">🎤</span>
            <div>
              <h3>Share Your Story</h3>
              <p>Are you studying or working abroad? We'd love to feature your experience and help future students.</p>
            </div>
            <Link to="/contact" className="la-submit-btn">Submit Your Story</Link>
          </div>
        </div>
      </div></main>

      <SiteFooter />
    </div>
  );
}

export default LifeAbroadPage;
