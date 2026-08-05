// Curated IVYhuts destination markets (static — not Amber inventory enumeration).
// Shared by the homepage's Popular Cities/Explore sections and the listings
// page's breadcrumb/city-description header so the two stay in sync.
export const DESTINATIONS = [
  { name: "London", country: "UK", flag: "🇬🇧", description: "Iconic student districts, fast transport and a global community.", image: "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=900&q=80&auto=format&fit=crop" },
  { name: "Manchester", country: "UK", flag: "🇬🇧", description: "Vibrant city life, strong university network and great value.", image: "https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=900&q=80&auto=format&fit=crop" },
  { name: "Birmingham", country: "UK", flag: "🇬🇧", description: "A fast-growing student hub with excellent transport links.", image: "https://images.unsplash.com/photo-1500534623283-312aade485b7?w=900&q=80&auto=format&fit=crop" },
  { name: "Coventry", country: "UK", flag: "🇬🇧", description: "Budget-friendly living close to major universities.", image: "https://images.unsplash.com/photo-1494526585095-c41746248156?w=900&q=80&auto=format&fit=crop" },
  { name: "Leeds", country: "UK", flag: "🇬🇧", description: "Young energy, nightlife and great student facilities.", image: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=900&q=80&auto=format&fit=crop" },
  { name: "Liverpool", country: "UK", flag: "🇬🇧", description: "A lively culture scene with affordable student homes.", image: "https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=900&q=80&auto=format&fit=crop" },
  { name: "Sheffield", country: "UK", flag: "🇬🇧", description: "Beautiful green spaces and a welcoming student community.", image: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=900&q=80&auto=format&fit=crop" },
  { name: "Glasgow", country: "UK", flag: "🇬🇧", description: "Historic, stylish and packed with accommodation options.", image: "https://images.unsplash.com/photo-1516483638261-f4dbaf036963?w=900&q=80&auto=format&fit=crop" },
  { name: "Toronto", country: "Canada", flag: "🇨🇦", description: "Modern city life with excellent campus access and transit.", image: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=900&q=80&auto=format&fit=crop" },
  { name: "Vancouver", country: "Canada", flag: "🇨🇦", description: "Scenic surroundings and premium student neighbourhoods.", image: "https://images.unsplash.com/photo-1519501025264-65ba15a82390?w=900&q=80&auto=format&fit=crop" },
  { name: "Sydney", country: "Australia", flag: "🇦🇺", description: "Beachside living with flexible housing options for students.", image: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=900&q=80&auto=format&fit=crop" },
  { name: "Melbourne", country: "Australia", flag: "🇦🇺", description: "A creative, culture-rich city with great student support.", image: "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?w=900&q=80&auto=format&fit=crop" },
];

export const COUNTRIES = Array.from(new Set(DESTINATIONS.map((d) => d.country)));

const COUNTRY_FULL_NAMES = { UK: "United Kingdom", Canada: "Canada", Australia: "Australia" };

export function findDestination(cityName) {
  if (!cityName) return null;
  const clean = cityName.trim().toLowerCase();
  return DESTINATIONS.find((d) => d.name.toLowerCase() === clean) || null;
}

export function countryFullName(code) {
  return COUNTRY_FULL_NAMES[code] || code;
}