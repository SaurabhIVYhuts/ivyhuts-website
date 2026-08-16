import {
  Wifi, Router, Zap, Flame, FlameKindling, Droplet, Dumbbell, Sparkles, Bike, Camera,
  ShieldCheck, KeyRound, WashingMachine, ParkingCircle, Car, ArrowUpDown, Trees, BookOpen,
  Film, Music, Gamepad2, Package, Users, Smartphone, Headphones, FileCheck, Recycle, Wrench,
  Mail, ConciergeBell, Tv, Sofa, Utensils, Coffee, Snowflake, Dog, Accessibility, Baby, Bath,
  Bed, Warehouse, Refrigerator, Microwave, Armchair, CreditCard, Building2, CheckCircle2,
  Martini, Presentation, Mic2, Podcast, Heart,
} from "lucide-react";

// Amber's amenity names are real free text pulled from each property's own
// listing, not a fixed enum this codebase controls (see amberMapper.js's
// getAmenityGroups) — there is no canonical id to look an icon up by, only
// the string itself. So this is a curated keyword match over names actually
// observed across the catalog ("Wi-Fi", "Electric", "CCTV", "Onsite Service
// Team", "Content Insurance", ...), ordered most-specific-first since the
// first matching pattern wins. CheckCircle2 is the deliberate generic
// fallback for a real amenity this list doesn't recognize yet — every item
// always gets SOME icon, never a blank gap in the row.
const AMENITY_ICON_RULES = [
  [/wi-?fi|broadband|internet/i, Wifi],
  [/router/i, Router],
  [/electric/i, Zap],
  [/\bgas\b/i, Flame],
  [/fire/i, FlameKindling],
  [/heat/i, Flame],
  [/water/i, Droplet],
  [/gym|fitness/i, Dumbbell],
  [/yoga|wellness|wellbeing/i, Heart],
  [/bike|cycle/i, Bike],
  [/cctv|camera|surveillan/i, Camera],
  [/secure|security|access control/i, ShieldCheck],
  [/\bkey|lock/i, KeyRound],
  [/laundry|washing/i, WashingMachine],
  [/parking|garage/i, ParkingCircle],
  [/\bcar\b|vehicle/i, Car],
  [/lift|elevator/i, ArrowUpDown],
  [/garden|outdoor|terrace|rooftop|balcony|patio/i, Trees],
  [/study|library|reading/i, BookOpen],
  [/cinema|movie|theatre|screening/i, Film],
  [/karaoke/i, Mic2],
  [/podcast/i, Podcast],
  [/auditorium|presentation|conference/i, Presentation],
  [/\bbar\b/i, Martini],
  [/music/i, Music],
  [/gam(e|ing)/i, Gamepad2],
  [/vending/i, Package],
  [/common area|social|lounge|communal/i, Users],
  [/app\b/i, Smartphone],
  [/24\/7|assistance|support|service team|onsite|on-site|staff/i, Headphones],
  [/insurance/i, FileCheck],
  [/waste|recycl/i, Recycle],
  [/maintenance|repair/i, Wrench],
  [/parcel|delivery|post|mail/i, Mail],
  [/reception|concierge/i, ConciergeBell],
  [/clean/i, Sparkles],
  [/\btv\b|television|media room/i, Tv],
  [/sofa|living room|common room/i, Sofa],
  [/kitchen|dining|utensil/i, Utensils],
  [/coffee/i, Coffee],
  [/air ?con|a\/c\b|cooling/i, Snowflake],
  [/pet/i, Dog],
  [/wheelchair|accessib/i, Accessibility],
  [/baby|child/i, Baby],
  [/bath|shower/i, Bath],
  [/\bbed/i, Bed],
  [/storage|warehouse/i, Warehouse],
  [/fridge|refrigerator/i, Refrigerator],
  [/microwave/i, Microwave],
  [/armchair|furnitur/i, Armchair],
  [/bills? included/i, CreditCard],
  [/building|residence|propert/i, Building2],
];

export function getAmenityIcon(name) {
  const text = String(name || "");
  for (const [pattern, Icon] of AMENITY_ICON_RULES) {
    if (pattern.test(text)) return Icon;
  }
  return CheckCircle2;
}
