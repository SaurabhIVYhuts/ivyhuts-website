import React from "react";
import { Link } from "react-router-dom";
import SiteNavbar from "../components/layout/SiteNavbar";
import SiteFooter from "../components/layout/SiteFooter";
import Seo from "../components/Seo";
import "./NotFoundPage.css";

/*  Catch-all for any unmatched URL. Before this route existed, an unknown
    path (a stale link, a deleted /property/<slug>, a typo) rendered a blank
    page but still returned HTTP 200 — which Google reports as "Soft 404".
    A pure CRA SPA cannot set a real 404 status code from the client, so the
    honest signal we CAN send is <meta name="robots" content="noindex">
    plus a clear, useful not-found UI.  */
export default function NotFoundPage() {
  return (
    <div className="notfound-page">
      <Seo
        title="Page not found"
        description="The page you were looking for doesn't exist or has moved."
        noindex
      />
      <SiteNavbar />
      <main className="notfound-body">
        <p className="notfound-code">404</p>
        <h1>We couldn't find that page</h1>
        <p className="notfound-lead">
          The link may be broken, or the page may have been moved or removed.
        </p>
        <div className="notfound-actions">
          <Link to="/" className="btn btn-primary">Go to homepage</Link>
          <Link to="/find-rooms" className="btn btn-secondary">Browse accommodation</Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
