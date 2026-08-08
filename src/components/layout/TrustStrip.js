import React from "react";
import { USPS } from "../../data/usps";

export default function TrustStrip() {
  return (
    <section className="trust-strip">
      <div className="trust-strip-inner">
        {USPS.map((u, i) => (
          <React.Fragment key={u.key}>
            {i > 0 && <div className="trust-divider" />}
            <div className="trust-badge">
              {React.cloneElement(u.icon, { className: "trust-icon" })}
              <div>
                <div className="trust-label">{u.label}</div>
                <div className="trust-sub">{u.sub}</div>
              </div>
            </div>
          </React.Fragment>
        ))}
      </div>
    </section>
  );
}
