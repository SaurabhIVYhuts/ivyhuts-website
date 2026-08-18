// Straight-line (Haversine) distance only — reuses the exact formula
// already proven in api/_lib/accommodationIndex.js (used there for Student
// Planner ranking), rather than a third copy of the same math (a second
// copy already exists, deliberately, as src/lib/geoDistance.js's frontend
// twin — see that file's own header comment). Deliberately NOT walking/
// travel time: that requires a real routing provider, which Milestone 23.3
// explicitly does not add.
const { haversineKm } = require("../../accommodationIndex");

function hasFiniteCoords(point) {
    return Boolean(point) && typeof point.latitude === "number" && typeof point.longitude === "number" && Number.isFinite(point.latitude) && Number.isFinite(point.longitude);
}

// Returns null (never 0, never a guess) whenever either point is missing or
// not a real finite coordinate pair — a property or a university with
// unknown coordinates simply has no computable distance, not a fabricated
// one.
function distanceFromUniversityKm(universityCoordinates, propertyCoordinates) {
    if (!hasFiniteCoords(universityCoordinates) || !hasFiniteCoords(propertyCoordinates)) return null;
    return haversineKm(universityCoordinates.latitude, universityCoordinates.longitude, propertyCoordinates.latitude, propertyCoordinates.longitude);
}

module.exports = { distanceFromUniversityKm };
