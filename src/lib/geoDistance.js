// Plain local Haversine (no library, no external API, no geocoding request)
// — straight-line km between two lat/lng points. Frontend twin of
// api/_lib/accommodationIndex.js's haversineKm() (same formula); duplicated
// rather than imported because api/_lib is a separate CommonJS bundling
// context with no build step reaching into src/ (same precedent as
// src/lib/universityResolver.js vs api/_lib/universityResolver.js).
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's mean radius, km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function hasValidCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}
