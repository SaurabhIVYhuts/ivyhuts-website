// Curated IVYhuts destination markets (static — not Amber inventory enumeration).
// Shared by the homepage's Popular Cities/Explore sections and the listings
// page's breadcrumb/city-description header so the two stay in sync.
//
// Every entry here is confirmed to have REAL Amber inventory (verified live,
// not just from the crawl's own bucketing — see the Italy/Hong Kong comment
// below for why that distinction matters) — a curated "explore this city"
// card whose own link leads to zero properties is worse than no card at all.
// Previously included 12 countries (Japan, Malaysia, South Korea,
// Netherlands, Sweden, Switzerland, Poland, Czech Republic, Denmark,
// Portugal, Austria, Belgium) and 4 individual cities in otherwise-real
// countries (Brisbane, Frankfurt, Christchurch, Abu Dhabi) that had ZERO
// real properties under their name anywhere in the crawl — removed. Italy
// and Hong Kong were removed the same way (Milan/Rome/"Hong Kong" itself
// were genuinely empty) then re-added once real inventory was confirmed
// under different names. A market showing up here again in the future
// should only happen once real inventory actually exists there, not
// preemptively.
export const DESTINATIONS = [
  { name: "London", country: "UK", flag: "🇬🇧", description: "Iconic student districts, fast transport and a global community.", image: "https://images.unsplash.com/photo-1520986606214-8b456906c813?w=900&q=80&auto=format&fit=crop" },
  { name: "Coventry", country: "UK", flag: "🇬🇧", description: "Budget-friendly living close to major universities.", image: "https://images.unsplash.com/photo-1494522855154-9297ac14b55f?w=900&q=80&auto=format&fit=crop" },
  { name: "Nottingham", country: "UK", flag: "🇬🇧", description: "Two major universities and a lively, affordable city centre.", image: "https://images.unsplash.com/photo-1608976409757-8aa9957f98ed?w=900&q=80&auto=format&fit=crop" },
  { name: "Liverpool", country: "UK", flag: "🇬🇧", description: "A lively culture scene with affordable student homes.", image: "https://images.unsplash.com/photo-1449844908441-8829872d2607?w=900&q=80&auto=format&fit=crop" },
  { name: "Birmingham", country: "UK", flag: "🇬🇧", description: "A fast-growing student hub with excellent transport links.", image: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=900&q=80&auto=format&fit=crop" },
  { name: "Leicester", country: "UK", flag: "🇬🇧", description: "A diverse, welcoming city with strong student communities.", image: "https://images.unsplash.com/photo-1680001371684-eb03b9728a3e?w=900&q=80&auto=format&fit=crop" },
  { name: "Manchester", country: "UK", flag: "🇬🇧", description: "Vibrant city life, strong university network and great value.", image: "https://images.unsplash.com/photo-1480714378408-67cf0d13bc1b?w=900&q=80&auto=format&fit=crop" },
  { name: "Leeds", country: "UK", flag: "🇬🇧", description: "Young energy, nightlife and great student facilities.", image: "https://images.unsplash.com/photo-1683459269288-63ce626a67f2?w=900&q=80&auto=format&fit=crop" },
  { name: "Sheffield", country: "UK", flag: "🇬🇧", description: "Beautiful green spaces and a welcoming student community.", image: "https://images.unsplash.com/photo-1501785888041-af3ef285b470?w=900&q=80&auto=format&fit=crop" },
  { name: "Glasgow", country: "UK", flag: "🇬🇧", description: "Historic, stylish and packed with accommodation options.", image: "https://images.unsplash.com/photo-1706606992443-538c5271ae41?w=900&q=80&auto=format&fit=crop" },
  { name: "Newcastle Upon Tyne", country: "UK", flag: "🇬🇧", description: "Legendary nightlife, riverside living and close-knit campuses.", image: "https://images.unsplash.com/photo-1629858997805-d29f2c3b5c4a?w=900&q=80&auto=format&fit=crop" },
  { name: "Exeter", country: "UK", flag: "🇬🇧", description: "A safe, scenic cathedral city with a close campus feel.", image: "https://images.unsplash.com/photo-1745944727108-c7d3a74f2f64?w=900&q=80&auto=format&fit=crop" },
  { name: "Guildford", country: "UK", flag: "🇬🇧", description: "A safe, leafy Surrey town with quick London access and home to the University of Surrey.", image: "https://images.unsplash.com/photo-1763148891417-1bd461968ddd?w=900&q=80&auto=format&fit=crop" },
  { name: "Hatfield", country: "UK", flag: "🇬🇧", description: "A compact Hertfordshire town with quick London access and home to the University of Hertfordshire.", image: "https://images.unsplash.com/photo-1734771227131-3fc1bff68f78?w=900&q=80&auto=format&fit=crop" },
  { name: "Edinburgh", country: "UK", flag: "🇬🇧", description: "Scotland's historic capital — cobbled streets, a thriving festival scene and home to the University of Edinburgh.", image: "https://images.unsplash.com/photo-1506377585622-bedcbb027afc?w=900&q=80&auto=format&fit=crop" },
  { name: "Bristol", country: "UK", flag: "🇬🇧", description: "A creative, harbourside city with a strong tech scene and two major universities.", image: "https://images.unsplash.com/photo-1642086514558-5cb2a04c336d?w=900&q=80&auto=format&fit=crop" },
  { name: "Brighton", country: "UK", flag: "🇬🇧", description: "A lively seaside city with a huge student population and an iconic pier.", image: "https://images.unsplash.com/photo-1519056250922-3e4080176575?w=900&q=80&auto=format&fit=crop" },
  { name: "Cardiff", country: "UK", flag: "🇬🇧", description: "Wales' compact, friendly capital — affordable living close to Cardiff University.", image: "https://images.unsplash.com/photo-1595273647789-54432cefc8e1?w=900&q=80&auto=format&fit=crop" },
  { name: "York", country: "UK", flag: "🇬🇧", description: "A walled cathedral city steeped in history, with a close-knit student community.", image: "https://images.unsplash.com/photo-1682346361366-4ba6b4a943f0?w=900&q=80&auto=format&fit=crop" },
  { name: "Aberdeen", country: "UK", flag: "🇬🇧", description: "Scotland's granite city — affordable living and two well-established universities.", image: "https://images.unsplash.com/photo-1609947017833-8ef56ef5e9e2?w=900&q=80&auto=format&fit=crop" },
  { name: "Belfast", country: "UK", flag: "🇬🇧", description: "Northern Ireland's capital, with a growing student scene and a low cost of living.", image: "https://images.unsplash.com/photo-1630408924399-012c0065f388?w=900&q=80&auto=format&fit=crop" },
  { name: "Toronto", country: "Canada", flag: "🇨🇦", description: "Modern city life with excellent campus access and transit.", image: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=900&q=80&auto=format&fit=crop" },
  { name: "Vancouver", country: "Canada", flag: "🇨🇦", description: "Scenic surroundings and premium student neighbourhoods.", image: "https://images.unsplash.com/photo-1730661906876-18bfc6e95f2f?w=900&q=80&auto=format&fit=crop" },
  { name: "Ottawa", country: "Canada", flag: "🇨🇦", description: "The nation's capital, with a calm, academic atmosphere.", image: "https://images.unsplash.com/photo-1578973615934-8d9cdb0792b4?w=900&q=80&auto=format&fit=crop" },
  { name: "Waterloo", country: "Canada", flag: "🇨🇦", description: "Canada's tech and innovation hub, home to the University of Waterloo.", image: "https://images.unsplash.com/photo-1602615181009-a9dacd14e11c?w=900&q=80&auto=format&fit=crop" },
  { name: "Sydney", country: "Australia", flag: "🇦🇺", description: "Beachside living with flexible housing options for students.", image: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=900&q=80&auto=format&fit=crop" },
  { name: "Melbourne", country: "Australia", flag: "🇦🇺", description: "A creative, culture-rich city with great student support.", image: "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?w=900&q=80&auto=format&fit=crop" },
  { name: "New York", country: "USA", flag: "🇺🇸", description: "The city that never sleeps, with world-class universities.", image: "https://images.unsplash.com/photo-1781033966124-3539e5a3c2d1?w=900&q=80&auto=format&fit=crop" },
  { name: "Boston", country: "USA", flag: "🇺🇸", description: "An academic powerhouse with a rich campus culture.", image: "https://images.unsplash.com/photo-1460472178825-e5240623afd5?w=900&q=80&auto=format&fit=crop" },
  { name: "Chicago", country: "USA", flag: "🇺🇸", description: "A major student hub with iconic architecture and transit.", image: "https://images.unsplash.com/photo-1493134799591-2c9eed26201a?w=900&q=80&auto=format&fit=crop" },
  { name: "Los Angeles", country: "USA", flag: "🇺🇸", description: "Sun, film industry energy and sprawling campuses across the city.", image: "https://images.unsplash.com/photo-1597982087634-9884f03198ce?w=900&q=80&auto=format&fit=crop" },
  { name: "Austin", country: "USA", flag: "🇺🇸", description: "Texas' tech-forward capital, live-music culture and home to the University of Texas at Austin.", image: "https://images.unsplash.com/photo-1557335200-a65f7f032602?w=900&q=80&auto=format&fit=crop" },
  { name: "Houston", country: "USA", flag: "🇺🇸", description: "A major energy and business hub with a large, diverse student population.", image: "https://images.unsplash.com/photo-1622007149524-9d73353bd327?w=900&q=80&auto=format&fit=crop" },
  { name: "Seattle", country: "USA", flag: "🇺🇸", description: "A tech powerhouse on the Pacific coast, home to the University of Washington.", image: "https://images.unsplash.com/photo-1502175353174-a7a70e73b362?w=900&q=80&auto=format&fit=crop" },
  { name: "Philadelphia", country: "USA", flag: "🇺🇸", description: "A historic East Coast city packed with universities and student energy.", image: "https://images.unsplash.com/photo-1581909811589-a1317515f20c?w=900&q=80&auto=format&fit=crop" },
  { name: "Washington", country: "USA", flag: "🇺🇸", description: "The nation's capital — internships, politics and a dense cluster of universities.", image: "https://images.unsplash.com/photo-1565571370459-5c78ebb358de?w=900&q=80&auto=format&fit=crop" },
  { name: "Kansas City", country: "USA", flag: "🇺🇸", description: "An affordable Midwest hub with a fast-growing tech and student community.", image: "https://images.unsplash.com/photo-1784398309796-5b37ff48d051?w=900&q=80&auto=format&fit=crop" },
  { name: "Minneapolis", country: "USA", flag: "🇺🇸", description: "A twin-cities hub with strong universities and a famously green, liveable core.", image: "https://images.unsplash.com/photo-1643653186431-1e7b4c6ef7b5?w=900&q=80&auto=format&fit=crop" },
  { name: "Orlando", country: "USA", flag: "🇺🇸", description: "A fast-growing Florida city with a huge student population at UCF.", image: "https://images.unsplash.com/photo-1609184889233-eff6dd93def4?w=900&q=80&auto=format&fit=crop" },
  { name: "San Antonio", country: "USA", flag: "🇺🇸", description: "A historic Texas city on the Riverwalk, with a fast-growing student population.", image: "https://images.unsplash.com/photo-1767134426251-789d10a6404f?w=900&q=80&auto=format&fit=crop" },
  { name: "Berlin", country: "Germany", flag: "🇩🇪", description: "A creative capital with low costs and top-ranked universities.", image: "https://images.unsplash.com/photo-1745878136928-d1b3c10afc35?w=900&q=80&auto=format&fit=crop" },
  { name: "Munich", country: "Germany", flag: "🇩🇪", description: "Safe, prosperous and home to leading technical universities.", image: "https://images.unsplash.com/photo-1544267822-2d9ac57fc38b?w=900&q=80&auto=format&fit=crop" },
  { name: "Madrid", country: "Spain", flag: "🇪🇸", description: "A vibrant capital with an unbeatable student social scene.", image: "https://images.unsplash.com/photo-1569676814972-31aa39db5817?w=900&q=80&auto=format&fit=crop" },
  { name: "Barcelona", country: "Spain", flag: "🇪🇸", description: "Beachside living with a strong international student scene.", image: "https://images.unsplash.com/photo-1745186487192-09eccb385169?w=900&q=80&auto=format&fit=crop" },
  { name: "Valencia", country: "Spain", flag: "🇪🇸", description: "Beaches, affordability and a fast-growing international student community.", image: "https://images.unsplash.com/photo-1617122287896-8638ac5c5414?w=900&q=80&auto=format&fit=crop" },
  { name: "Paris", country: "France", flag: "🇫🇷", description: "World-renowned institutions in the heart of Europe.", image: "https://images.unsplash.com/photo-1566896662405-4021fa760f36?w=900&q=80&auto=format&fit=crop" },
  { name: "Lyon", country: "France", flag: "🇫🇷", description: "A compact, affordable city with a strong student community.", image: "https://images.unsplash.com/photo-1740647981134-cb1e4e057a1b?w=900&q=80&auto=format&fit=crop" },
  { name: "Toulouse", country: "France", flag: "🇫🇷", description: "The 'Pink City' — aerospace, engineering and a huge student population.", image: "https://images.unsplash.com/photo-1628412813537-16d4334c0029?w=900&q=80&auto=format&fit=crop" },
  { name: "Singapore", country: "Singapore", flag: "🇸🇬", description: "A safe, ultra-modern global gateway for students in Asia.", image: "https://images.unsplash.com/photo-1749843990627-3cd919ef8aac?w=900&q=80&auto=format&fit=crop" },
  { name: "Auckland", country: "New Zealand", flag: "🇳🇿", description: "Relaxed island living with globally respected universities.", image: "https://images.unsplash.com/photo-1507699622108-4be3abd695ad?w=900&q=80&auto=format&fit=crop" },
  { name: "Wellington", country: "New Zealand", flag: "🇳🇿", description: "New Zealand's compact, walkable capital and student hub.", image: "https://images.unsplash.com/photo-1624589010805-b4e69450ed87?w=900&q=80&auto=format&fit=crop" },
  { name: "Dubai", country: "UAE", flag: "🇦🇪", description: "A tax-free, fast-growing hub for international campuses.", image: "https://images.unsplash.com/photo-1745750434535-5943ef2fd31a?w=900&q=80&auto=format&fit=crop" },
  { name: "Dublin", country: "Ireland", flag: "🇮🇪", description: "Europe's tech capital, with a buzzing, friendly student community.", image: "https://images.unsplash.com/photo-1549918864-48ac978761a4?w=900&q=80&auto=format&fit=crop" },
  { name: "Cork", country: "Ireland", flag: "🇮🇪", description: "Ireland's second city — compact, affordable and student-friendly.", image: "https://images.unsplash.com/photo-1590089415225-401ed6f9db8e?w=900&q=80&auto=format&fit=crop" },
  // Italy and Hong Kong were removed as whole countries earlier (Milan/Rome/
  // "Hong Kong" all showed zero real inventory), then confirmed to have real,
  // live-queryable inventory under DIFFERENT names — Florence/Bologna
  // (verified live: 3 and 1 real bookable properties respectively) and Hong
  // Kong itself (verified live: 3 real properties, even though the crawl's
  // own locality-based bucketing couldn't tag them — Amber's own city search
  // still resolves "Hong Kong" to them). Re-added under these confirmed names.
  { name: "Florence", country: "Italy", flag: "🇮🇹", description: "The cradle of the Renaissance — art, history and a compact, walkable student city.", image: "https://images.unsplash.com/photo-1528114039593-4366cc08227d?w=900&q=80&auto=format&fit=crop" },
  { name: "Bologna", country: "Italy", flag: "🇮🇹", description: "Italy's oldest university city — medieval porticoes, red-brick streets and a huge student population.", image: "https://images.unsplash.com/photo-1766845001798-e2f225c2b31e?w=900&q=80&auto=format&fit=crop" },
  { name: "Hong Kong", country: "Hong Kong", flag: "🇭🇰", description: "A dense, world-class financial hub with top-ranked universities.", image: "https://images.unsplash.com/photo-1620015092538-e33c665fc181?w=900&q=80&auto=format&fit=crop" },
];

export const COUNTRIES = Array.from(new Set(DESTINATIONS.map((d) => d.country)));

const COUNTRY_FULL_NAMES = {
  UK: "United Kingdom",
  Canada: "Canada",
  Australia: "Australia",
  USA: "United States",
  Germany: "Germany",
  Spain: "Spain",
  France: "France",
  Singapore: "Singapore",
  "New Zealand": "New Zealand",
  UAE: "United Arab Emirates",
  Ireland: "Ireland",
  Italy: "Italy",
  "Hong Kong": "Hong Kong",
};

export function findDestination(cityName) {
  if (!cityName) return null;
  const clean = cityName.trim().toLowerCase();
  return DESTINATIONS.find((d) => d.name.toLowerCase() === clean) || null;
}

export function countryFullName(code) {
  return COUNTRY_FULL_NAMES[code] || code;
}

const COUNTRY_ISO_CODES = {
  UK: "GB",
  Canada: "CA",
  Australia: "AU",
  USA: "US",
  Germany: "DE",
  Spain: "ES",
  France: "FR",
  Singapore: "SG",
  "New Zealand": "NZ",
  UAE: "AE",
  Ireland: "IE",
  Italy: "IT",
  "Hong Kong": "HK",
};

export function countryIsoCode(code) {
  return COUNTRY_ISO_CODES[code] || code;
}
