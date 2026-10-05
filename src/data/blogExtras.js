/*  Per-article PRESENTATION extras, keyed by slug — images, tip boxes,
    category, FAQs. Kept out of the article itself so the stored Markdown
    (database / src/data/blogs.json) stays exactly as written and the blog
    API is unchanged. An article with no entry here still renders normally.

    `sections` is keyed by heading id (see slugifyHeading in
    src/components/blog/BlogContent.js — the "## " heading text without its
    leading number). `variant: "cta"` renders that section as a highlighted
    call-to-action panel. Optional `cta: { help, final }` overrides that
    panel's primary button and the closing CTA (defaults: University
    Housing — see DEFAULT_CTA in src/pages/BlogPostPage.js).

    Photos: real photography from Unsplash (https://unsplash.com/license —
    free for commercial use, attribution NOT required), stored locally under
    public/images/blog/<slug>/ (NOT public/blog/ — a folder there would
    shadow the /blog page routes). Credits are kept here as a record; a
    visible caption renders only for images whose licence requires one
    (`credit.required: true`, e.g. CC BY photos).  */

const IMG = "/images/blog/how-to-choose-student-accommodation-abroad";
const LONDON_IMG = "/images/blog/student-accommodation-in-london";

const unsplash = (name, url) => ({ name, url, source: "Unsplash", required: false });

const BLOG_EXTRAS = {
  "how-to-choose-student-accommodation-abroad": {
    category: "Accommodation Guide",
    hero: {
      src: `${IMG}/hero-campus.jpg`,
      width: 1600,
      height: 900,
      alt: "Students walking across a sunny university campus past modern faculty buildings",
      credit: unsplash("Wonderlane", "https://unsplash.com/photos/6zlgM-GUd6I"),
    },
    sections: {
      "choose-a-convenient-location-near-your-university": {
        image: {
          src: `${IMG}/location-students-walking.jpg`,
          alt: "A group of students walking together along a city street between campus and local shops",
          credit: unsplash("Eliott Reyna", "https://unsplash.com/photos/jCEpN62oWL4"),
        },
        tip: {
          title: "Quick tip",
          text: "Before you book, map the route from the property to your campus and check how long the journey takes by public transport or on foot at the time your classes start.",
        },
      },
      "consider-your-budget-and-the-total-cost": {
        tip: {
          title: "Budget checklist",
          text: "Add up rent, bills (electricity, water, heating and internet), laundry, transport and the security deposit to see the true monthly cost, not just the advertised rent.",
        },
      },
      "check-safety-and-security": {
        image: {
          src: `${IMG}/safety-building-entrance.jpg`,
          alt: "Gated entrance of a residential building with secure access and landscaped gardens",
          credit: unsplash("Linus Belanger", "https://unsplash.com/photos/NycGWaEgtm8"),
        },
      },
      "understand-the-types-of-student-accommodation": {
        image: {
          src: `${IMG}/room-single-bedroom.jpg`,
          alt: "A bright private room with a double bed, wooden floor and a large window",
          credit: unsplash("CHUTTERSNAP", "https://unsplash.com/photos/ftG8WcHwg7o"),
        },
      },
      "check-the-available-amenities": {
        image: {
          src: `${IMG}/amenities-shared-kitchen.jpg`,
          alt: "A shared kitchen with a cooker, shelves and natural light, a common amenity in student housing",
          credit: unsplash("Y K", "https://unsplash.com/photos/bn4Ve3NjQ8g"),
        },
      },
      "think-about-your-study-environment": {
        image: {
          src: `${IMG}/study-library.jpg`,
          alt: "A student studying on a laptop in a quiet university library reading room",
          credit: unsplash("Zoshua Colah", "https://unsplash.com/photos/Ma7aOy5mMp0"),
        },
      },
      "read-the-accommodation-contract-carefully": {
        tip: {
          title: "Before you sign",
          text: "Ask for the cancellation policy and notice period in writing, and keep a copy of the signed agreement for your records.",
        },
      },
      "check-reviews-and-property-information": {
        tip: {
          title: "Reading reviews",
          text: "Recent reviews that mention maintenance and how quickly management responds often tell you the most about everyday life in a property.",
        },
      },
      "think-about-your-lifestyle": {
        image: {
          src: `${IMG}/lifestyle-students-cafe.jpg`,
          alt: "Students talking and working together over coffee in a café",
          credit: unsplash("Brooke Cagle", "https://unsplash.com/photos/-uHVRvDr7pg"),
        },
      },
      "how-ivyhuts-can-help-you-find-student-housing": {
        variant: "cta",
      },
    },
    faqs: [
      {
        q: "What should I consider when choosing student accommodation abroad?",
        a: "Start with location, total cost and safety, then compare room types, amenities, the study environment, contract terms and reviews from other students. The right choice is the one that fits your needs, your budget and your lifestyle.",
      },
      {
        q: "How do I find student accommodation abroad?",
        a: "Begin searching as soon as your study plans are confirmed, shortlist options close to your university or good public transport, and compare them side by side. On IvyHuts you can explore student accommodation near your university through University Housing.",
      },
      {
        q: "What is the best accommodation for international students?",
        a: "There is no single best option. A private room or studio suits students who want privacy and a quiet place to study, while shared accommodation can help you meet other students and reduce costs.",
      },
      {
        q: "How can international students find affordable student accommodation?",
        a: "Compare the total monthly cost, not just the rent: check whether bills, internet and laundry are included, and factor in transport and the security deposit. Shared accommodation can lower costs, and a room close to campus can work out cheaper than a distant one once travel is included.",
      },
      {
        q: "How do I find safe student housing abroad?",
        a: "Look for secure building access, CCTV or security systems, well-maintained common areas, emergency support and good lighting around the property. Research the neighbourhood and read reviews from students who have lived there.",
      },
      {
        q: "What should I check before booking student accommodation?",
        a: "Read the contract carefully: rental period, payment schedule, security deposit, cancellation policy, notice period, house rules, guest policies and maintenance responsibilities. Ask the provider to clarify anything you don't understand before you sign.",
      },
      {
        q: "When should I start looking for student accommodation abroad?",
        a: "As early as you can once your plans are confirmed. Starting early gives you time to compare options and read contracts properly, instead of rushing into a booking because you're worried a room may become unavailable.",
      },
      {
        q: "Can IvyHuts help me find student accommodation near my university?",
        a: "Yes. IvyHuts helps students explore accommodation options for their study journey abroad, so you can compare properties by location, budget, facilities and overall suitability, not just price or photos.",
      },
    ],
  },

  "student-accommodation-in-london": {
    category: "City Guide",
    hero: {
      src: `${LONDON_IMG}/hero-london-street.jpg`,
      width: 1600,
      height: 900,
      alt: "International students in London looking for student accommodation",
      credit: unsplash("Tamara Menzi", "https://unsplash.com/photos/Mptbg_EWLUs"),
    },
    cta: {
      help: { to: "/find-rooms?city=London", label: "Find Student Accommodation in London" },
      final: { heading: "Ready to find your accommodation in London?", to: "/find-rooms?city=London", label: "Explore London Student Accommodation" },
    },
    sections: {
      "popular-universities-in-london": {
        image: {
          src: `${LONDON_IMG}/university-ucl-portico.jpg`,
          alt: "International students near a London university",
          credit: unsplash("Surya Prasad", "https://unsplash.com/photos/aMIDCQQUXZI"),
        },
        tip: {
          title: "Important",
          text: "These universities have different campuses and locations, so students should check their exact campus before choosing accommodation.",
        },
      },
      "popular-areas-for-student-accommodation-in-london": {
        image: {
          src: `${LONDON_IMG}/areas-residential-street.jpg`,
          alt: "Student neighbourhood in London",
          credit: unsplash("Loris Boulinguez", "https://unsplash.com/photos/YjmnoFxpgIU"),
        },
        tip: {
          title: "Tip",
          text: "Before booking, compare: University → Distance → Transport → Rent → Facilities → Lifestyle",
        },
      },
      "types-of-student-accommodation-in-london": {
        image: {
          src: `${LONDON_IMG}/room-student-bedroom.jpg`,
          alt: "Student accommodation room in London",
          credit: unsplash("Jonathan Borba", "https://unsplash.com/photos/wD3dur3v9aE"),
        },
      },
      "choosing-accommodation-based-on-your-university": {
        tip: {
          title: "Important",
          text: "Always check your exact campus because some universities operate across multiple locations.",
        },
      },
      "getting-around-london": {
        tip: {
          title: "Tip",
          text: "A room that looks cheaper may not actually be cheaper overall if you spend a lot of time and money commuting every day.",
        },
      },
      "student-life-in-london": {
        image: {
          src: `${LONDON_IMG}/life-primrose-hill.jpg`,
          alt: "International students enjoying student life in London",
          credit: unsplash("Markus Freise", "https://unsplash.com/photos/ev3Txp-zuns"),
        },
      },
      "how-to-choose-the-right-accommodation": {
        tip: {
          title: "Simple rule",
          text: "University → Location → Budget → Transport → Room → Facilities → Contract → Reviews",
        },
      },
      "how-ivyhuts-can-help": {
        variant: "cta",
      },
      "final-thoughts": {
        image: {
          src: `${LONDON_IMG}/cta-students-london-eye.jpg`,
          alt: "Student exploring London while studying abroad",
          credit: unsplash("Hannah Smith", "https://unsplash.com/photos/oRKFBA2nQ6A"),
        },
      },
    },
    faqs: [
      {
        q: "Is London a good city for international students?",
        a: "Yes. London has many universities, diverse communities, extensive public transport and a wide range of student activities.",
      },
      {
        q: "What is the best area for student accommodation in London?",
        a: "There is no single best area. The right area depends on your university, budget, commute and preferred lifestyle.",
      },
      {
        q: "How much does student accommodation cost in London?",
        a: "Costs vary depending on location, room type, facilities and other factors. Students should compare the total cost rather than rent alone.",
      },
      {
        q: "Which area is best for UCL students?",
        a: "Students can consider accommodation with convenient access to UCL's Bloomsbury area, while also comparing rent and transport.",
      },
      {
        q: "Is public transport convenient in London?",
        a: "Yes. London has Underground, buses, Overground, Elizabeth line, trams and National Rail services.",
      },
      {
        q: "What should international students check before booking?",
        a: "Students should check location, total cost, utilities, room type, tenancy agreement, deposit, property condition, safety and reviews.",
      },
      {
        q: "Should students live close to their university?",
        a: "Living close to university can reduce commuting time, but students should balance location with accommodation cost and transport connections.",
      },
      {
        q: "Can students find accommodation before arriving in the UK?",
        a: "Students can research and shortlist accommodation before travelling. However, they should verify the property, agreement and payment requirements carefully before making any payment.",
      },
    ],
  },
};

export function getBlogExtras(slug) {
  return BLOG_EXTRAS[slug] || null;
}
