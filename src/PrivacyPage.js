import React from "react";
import "./LegalPage.css";
import SiteNavbar from "./SiteNavbar";
import SiteFooter from "./SiteFooter";

export default function PrivacyPage() {
  return (
    <div className="legal-page">
      <SiteNavbar />

      <main><div className="legal-hero">
        <h1>Privacy Policy</h1>
        <p>Last updated: April 2026</p>
      </div>

      <div className="legal-body">
        <section className="legal-section">
          <h2>1. Who We Are</h2>
          <p>IvyHuts is a student accommodation platform. When you use our website or submit any form, you are sharing information with IvyHuts. Our contact email is <a href="mailto:saurabh@ivyhuts.com">saurabh@ivyhuts.com</a>.</p>
        </section>

        <section className="legal-section">
          <h2>2. What Information We Collect</h2>
          <p>We collect information you provide directly to us, including:</p>
          <ul>
            <li>Name, email address, and phone number when you submit an accommodation enquiry or contact us</li>
            <li>Accommodation preferences such as country, city, budget, and move-in date</li>
            <li>Property listing details when you use the "List Your Stay" form</li>
            <li>Account information (name and email) when you create an account</li>
          </ul>
          <p>We do not collect payment information, and we do not use tracking cookies beyond basic anonymous analytics.</p>
        </section>

        <section className="legal-section">
          <h2>3. How We Use Your Information</h2>
          <p>We use the information you provide to:</p>
          <ul>
            <li>Respond to your accommodation enquiries and find suitable options for you</li>
            <li>Contact you via email or WhatsApp with relevant accommodation shortlists</li>
            <li>Process property listing submissions and verify landlords</li>
            <li>Improve our platform and services</li>
          </ul>
          <p>We do not sell, rent, or share your personal information with third parties for their marketing purposes.</p>
        </section>

        <section className="legal-section">
          <h2>4. How We Store Your Data</h2>
          <p>Account data (name and email) is stored locally in your browser using localStorage. Enquiry data submitted through our forms is sent to our secure inbox via EmailJS and stored in our email system. We do not maintain a server-side database of user accounts at this stage.</p>
          <p>We take reasonable steps to protect your information, but no method of transmission over the internet is 100% secure.</p>
        </section>

        <section className="legal-section">
          <h2>5. Sharing Your Information</h2>
          <p>When we match you with a property, we may share your name, email, and phone number with the relevant property provider to facilitate the enquiry process. We will only share what is necessary and will inform you before doing so where possible.</p>
        </section>

        <section className="legal-section">
          <h2>6. Your Rights</h2>
          <p>You have the right to request access to, correction of, or deletion of your personal data at any time. To exercise these rights, please contact us at <a href="mailto:saurabh@ivyhuts.com">saurabh@ivyhuts.com</a>. We will respond within 30 days.</p>
        </section>

        <section className="legal-section">
          <h2>7. Cookies</h2>
          <p>We use minimal cookies for essential website functionality. We do not use advertising cookies or sell browsing data to third parties.</p>
        </section>

        <section className="legal-section">
          <h2>8. Changes to This Policy</h2>
          <p>We may update this policy from time to time. The date at the top of this page reflects the most recent revision. We encourage you to review this page periodically.</p>
        </section>

        <section className="legal-section">
          <h2>9. Contact Us</h2>
          <p>If you have any questions about how we handle your data, please email us at <a href="mailto:saurabh@ivyhuts.com">saurabh@ivyhuts.com</a>.</p>
        </section>
      </div></main>

      <SiteFooter />
    </div>
  );
}
