#!/usr/bin/env node
// One-time (re-runnable) maintenance sweep: re-validates every
// AccommodationResidence row for a given city against LIVE Amber and
// deletes rows whose slug no longer resolves to a real property.
//
// Why this exists: the AccommodationResidence mirror (api/_lib/models/
// AccommodationResidence.js) that backs the city listings page
// (api/city-listings.js -> readAllMongoResidences) is populated ONLY via
// upserts (see api/_lib/accommodationIndex.js's persistResidencesRaw) —
// nothing ever deleted a row, so once Amber stops serving a slug (removed,
// deactivated, re-slugged), that row sat in Mongo forever: visible on the
// listing page, 404ing on the detail page. api/amber.js's indexOnRead now
// self-heals this going forward (deletes a row the moment a live detail
// fetch confirms the slug is gone), but that only fires as real traffic
// happens to revisit a given slug. This script does the same check
// proactively for everything already indexed.
//
// Rate-limit safety: Amber's hard limit is 10 req/min for the WHOLE
// partner account, shared with real site traffic. This script uses
// priority "LOW" (loses any race for a budget slot to real MEDIUM/HIGH
// traffic) and adds its own delay between requests on top of that, so it
// never competes with real users for Amber capacity — see amberGateway.js's
// own header comments on RATE_BUDGET_PER_MINUTE for why that budget is so
// conservative. This means a full-catalog run (thousands of rows) can take
// many hours; run it scoped to one city (--city) for a fast, bounded pass.
"use strict";

const path = require("path");
const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env.local") });
require("dotenv").config({ path: path.join(ROOT, ".env") });

const { connectToDatabase, disconnectFromDatabase } = require("../api/_lib/mongodb");
const AccommodationResidence = require("../api/_lib/models/AccommodationResidence");
const { fetchAmber, normalizeCityName, AmberGatewayError } = require("../api/_lib/amberGateway");
const { extractResultArray } = require("../api/_lib/accommodationIndex");

const SOURCE = "stale-residence-sweep";
// Own pacing floor between requests, independent of whatever the shared
// budget happens to allow at the moment — deliberately well under 10/min
// even in the best case, so this script's OWN worst-case throughput can
// never be the thing that exhausts the shared budget.
const DELAY_BETWEEN_REQUESTS_MS = Number(process.env.SWEEP_DELAY_MS) || 6000;
const BUDGET_BACKOFF_MS = 15000; // wait this long before retrying after losing the race for a slot

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const cityArg = process.argv.find((a) => a.startsWith("--city="));
    const city = cityArg ? cityArg.split("=")[1] : null;
    const normalizedCity = city ? normalizeCityName(city) : null;
    if (city && !normalizedCity) {
        console.error(`Could not normalize city "${city}"`);
        process.exit(1);
    }

    await connectToDatabase();
    const query = normalizedCity ? { city: normalizedCity } : {};
    const rows = await AccommodationResidence.find(query).select("_id slug propertyName city").lean();
    console.log(`[sweep] scope=${normalizedCity || "ALL CITIES"} rows=${rows.length} delayMs=${DELAY_BETWEEN_REQUESTS_MS}`);

    let checked = 0;
    let deleted = 0;
    let kept = 0;
    let errored = 0;
    const deletedList = [];
    const erroredList = [];

    for (const row of rows) {
        if (!row.slug) {
            kept++; // nothing to validate this by — leave alone
            continue;
        }

        let attempt = 0;
        // Retry loop is ONLY for "lost the race for a budget slot" (429
        // budget_exceeded/cooldown) — a transient, expected condition under
        // real traffic, not a failure. Any other error is logged and the
        // row is left untouched (never delete on an inconclusive result).
        for (;;) {
            attempt++;
            try {
                const result = await fetchAmber({ type: "detail", params: { slug: row.slug }, priority: "LOW", source: SOURCE });
                const item = extractResultArray(result.data)[0];
                checked++;
                if (!item) {
                    await AccommodationResidence.deleteOne({ _id: row._id });
                    deleted++;
                    deletedList.push(`${row.propertyName} (${row.slug})`);
                    console.log(`[sweep] DELETED  ${row.city}  ${row.propertyName}  ${row.slug}`);
                } else {
                    kept++;
                }
                break;
            } catch (err) {
                const isBudgetOrCooldown = err instanceof AmberGatewayError && (err.code === "budget_exceeded" || err.code === "cooldown");
                if (isBudgetOrCooldown && attempt < 20) {
                    await sleep(BUDGET_BACKOFF_MS);
                    continue;
                }
                errored++;
                erroredList.push(`${row.propertyName} (${row.slug}): ${err.message}`);
                console.log(`[sweep] ERROR    ${row.city}  ${row.propertyName}  ${row.slug}  ${err.message}`);
                break;
            }
        }

        if ((checked + errored) % 20 === 0) {
            console.log(`[sweep] progress: checked=${checked} deleted=${deleted} kept=${kept} errored=${errored} / total=${rows.length}`);
        }
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
    }

    console.log("\n[sweep] DONE");
    console.log(`[sweep] total=${rows.length} checked=${checked} deleted=${deleted} kept=${kept} errored=${errored}`);
    if (deletedList.length) {
        console.log("\n[sweep] Deleted properties:");
        deletedList.forEach((s) => console.log(`  - ${s}`));
    }
    if (erroredList.length) {
        console.log("\n[sweep] Errored (left untouched, needs a re-run):");
        erroredList.forEach((s) => console.log(`  - ${s}`));
    }

    await disconnectFromDatabase();
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("[sweep] FATAL", err);
        process.exit(1);
    });
