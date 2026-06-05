import React from "react";
import "./LegalPage.css";
import SiteNavbar from "./SiteNavbar";
import SiteFooter from "./SiteFooter";

export default function TermsPage() {
  return (
    <div className="legal-page">
      <SiteNavbar />

      <main><div className="legal-hero">
        <h1>Terms of Service</h1>
        <p>Last updated: April 2026</p>
      </div>

      <div className="legal-body">
        <section className="legal-section">
          <h2>1. About IvyHuts</h2>
          <p>IvyHuts ("we", "us", "our") is a student accommodation search and referral platform that connects international students with property listings worldwide. We are not a letting agent, landlord, or property manager. Our service is to help students discover accommodation options and facilitate introductions between students and property providers.</p>
        </section>

        <section className="legal-section">
          <h2>2. Using Our Service</h2>
          <p>By accessing or using IvyHuts, you agree to these terms. You must be at least 16 years old to use our platform. When you submit an enquiry or create an account, you confirm that the information you provide is accurate and up to date.</p>
          <p>You agree not to use the platform for any unlawful purpose, to misrepresent your identity, or to submit false enquiries. We reserve the right to suspend or terminate access for any user who violates these terms.</p>
        </section>

        <section className="legal-section">
          <h2>3. Our Role</h2>
          <p>IvyHuts acts as an intermediary. We do not own, manage, or control any of the properties listed or referenced on our platform. Any accommodation arrangement, contract, or tenancy agreement is directly between you and the property provider. We are not party to such agreements and accept no liability arising from them.</p>
          <p>Listings on our platform are verified to the best of our ability, but we cannot guarantee the accuracy, availability, or quality of any property. We strongly encourage you to conduct your own due diligence before committing to any accommodation.</p>
        </section>

        <section className="legal-section">
          <h2>4. Enquiry and Booking Process</h2>
          <p>Submitting an enquiry through IvyHuts is free and places no obligation on you to proceed with a booking. Our team will contact you with shortlisted options based on your requirements. Any fees or deposits are payable directly to the property provider, not to IvyHuts, unless otherwise agreed in writing.</p>
        </section>

        <section className="legal-section">
          <h2>5. No Visa No Pay Policy</h2>
          <p>Where a property provider offers a "No Visa No Pay" or similar visa-related refund policy, this is a commitment made by the property provider, not IvyHuts. The specific terms of any such policy are set by the property provider, and any refund claims must be made directly with them. IvyHuts will assist in facilitating such conversations where possible.</p>
        </section>

        <section className="legal-section">
          <h2>6. Intellectual Property</h2>
          <p>All content on this website, including text, design, and graphics, is owned by or licensed to IvyHuts. You may not reproduce, distribute, or use any content from this site without our prior written permission.</p>
        </section>

        <section className="legal-section">
          <h2>7. Limitation of Liability</h2>
          <p>IvyHuts is provided on an "as is" basis. We make no warranties, express or implied, about the accuracy, reliability, or suitability of the platform for your purposes. To the fullest extent permitted by law, IvyHuts shall not be liable for any indirect, incidental, or consequential loss arising from your use of the platform.</p>
        </section>

        <section className="legal-section">
          <h2>8. Changes to These Terms</h2>
          <p>We may update these terms from time to time. We will indicate the date of the latest revision at the top of this page. Continued use of the platform after changes constitutes your acceptance of the updated terms.</p>
        </section>

        <section className="legal-section">
          <h2>9. Contact</h2>
          <p>If you have any questions about these terms, please contact us at <a href="mailto:saurabh@ivyhuts.com">saurabh@ivyhuts.com</a>.</p>
        </section>
      </div></main>

      <SiteFooter />
    </div>
  );
}
