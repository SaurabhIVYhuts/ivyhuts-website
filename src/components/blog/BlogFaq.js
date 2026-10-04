import React from "react";

/*  FAQ accordion built on native <details>/<summary> — keyboard and
    screen-reader accessible with no JS state. Also emits schema.org
    FAQPage structured data so search engines can understand the Q&A.  */
export default function BlogFaq({ faqs, id = "faqs" }) {
  if (!faqs?.length) return null;
  const schema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
  return (
    <section className="blog-faq" aria-labelledby={id}>
      <h2 id={id}>Frequently Asked Questions</h2>
      <div className="blog-faq-list">
        {faqs.map(({ q, a }) => (
          <details key={q} className="blog-faq-item">
            <summary><h3 className="blog-faq-q">{q}</h3><span className="blog-faq-icon" aria-hidden="true" /></summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\u003c") }} />
    </section>
  );
}
