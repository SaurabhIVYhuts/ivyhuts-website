// Local fuzzy matching — the escalation step between Tier 1/2 exact lookup
// and AI-assisted interpretation (see api/_lib/universityResolveService.js
// for the full order). Pure, synchronous, zero I/O: this exists specifically
// to catch simple misspellings ("Univesity of Manchster") WITHOUT spending an
// AI call or an external geocoding request on something a plain edit-distance
// check already resolves confidently.
//
// Deliberately conservative: only ever returns a match when it is
// unambiguous and close enough to be confident (see THRESHOLD below) — same
// "no silent best-guess" discipline as the exact-match resolvers. Anything
// less certain falls through to AI-assisted interpretation instead of being
// guessed here.
"use strict";

function normalize(str) {
    return String(str || "")
        .toLowerCase()
        .replace(/[^\w\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

// Standard Levenshtein edit distance (insert/delete/substitute), O(n*m).
// Candidate names here are short (institution names), so no need for a
// fancier algorithm.
function levenshtein(a, b) {
    if (a === b) return 0;
    const la = a.length;
    const lb = b.length;
    if (la === 0) return lb;
    if (lb === 0) return la;
    let prev = new Array(lb + 1);
    let curr = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
        curr[0] = i;
        for (let j = 1; j <= lb; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[lb];
}

// Similarity as a 0..1 ratio (1 = identical), normalized by the longer
// string's length so short and long names are judged on a comparable scale.
function similarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(a, b) / maxLen;
}

// Below this similarity, a candidate is not considered a fuzzy match at all
// — high enough that genuine misspellings ("Univesity of Manchster" vs
// "University of Manchester", ~0.90) pass, while two merely-related but
// different institutions ("University of Leeds" vs "University of Derby")
// do not.
const THRESHOLD = 0.82;

// `candidates` is an array of { record, names: string[] } — each record's
// name + aliases, pre-normalized by the caller (so this stays pure/synchronous
// and never re-derives normalization rules in two places). Returns the single
// best-matching record if it is (a) above THRESHOLD and (b) unambiguous — no
// other candidate within 0.03 similarity of the best score — else null.
function fuzzyMatchCampusUniversity(query, candidates) {
    const q = normalize(query);
    if (!q || !Array.isArray(candidates) || candidates.length === 0) return null;

    let best = null;
    let bestScore = 0;
    let runnerUpScore = 0;

    for (const { record, names } of candidates) {
        let recordBest = 0;
        for (const name of names) {
            const score = similarity(q, name);
            if (score > recordBest) recordBest = score;
        }
        if (recordBest > bestScore) {
            runnerUpScore = bestScore;
            bestScore = recordBest;
            best = record;
        } else if (recordBest > runnerUpScore) {
            runnerUpScore = recordBest;
        }
    }

    if (!best || bestScore < THRESHOLD) return null;
    if (bestScore - runnerUpScore < 0.03) return null; // too close to call — ambiguous, don't guess
    return best;
}

module.exports = { fuzzyMatchCampusUniversity, similarity, levenshtein, normalize, THRESHOLD };
