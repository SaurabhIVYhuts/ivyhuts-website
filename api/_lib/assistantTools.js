// Ivy Assistant — READ-ONLY tool registry (Phase 1).
//
// Every tool here:
//   - is strictly read-only. There is no create/update/delete/assign tool,
//     by design. Adding one is a separate, deliberate decision.
//   - calls the existing in-process service modules DIRECTLY. No tool ever
//     makes an HTTP request back to our own API.
//   - enforces its own permission / visibility check inside `run` (never in
//     the model prompt). Lead-scoped tools require an internal role and run
//     the shared canActorSeeLead() check; catalogue tools (properties,
//     university, cost of living, salaries) are not actor-scoped because
//     they expose no customer data.
//
// `run(actor, args)` returns a plain JSON-serializable object. The endpoint
// truncates it before handing it back to the model and never streams the
// raw payload to the client (only a short human summary — see
// summarizeToolResult).
"use strict";

const { connectToDatabase } = require("./mongodb");
const { escapeRegex, isValidObjectId } = require("./validation");
const { toSafeLead, INTERNAL_ROLES, canActorSeeLead } = require("./leadView");

const Lead = require("./models/Lead");
const Meeting = require("./models/Meeting");
const Communication = require("./models/Communication");
const FollowUp = require("./models/FollowUp");

// Reuse the exact "safe shape" projections the real routes expose.
const meetingsRoute = require("./routes/leads/[id]/meetings/index.js");
const communicationsRoute = require("./routes/leads/[id]/communications/index.js");
const followUpsRoute = require("./routes/leads/[id]/follow-ups/index.js");
const workQueueRoute = require("./routes/leads/work-queue.js");

const { resolveUniversity, MAX_QUERY_LENGTH } = require("./universityResolveService");
const { getAccommodationInventory } = require("./accommodationInventoryService");
const { getCityLivingCost } = require("./costOfLiving");
const { resolveSalaryForCareer } = require("./salaryResolver");
const CAREERS = require("./careers.json");

const LEAD_STATUSES = ["new", "contacted", "qualified", "nurturing", "converted", "lost"];

// ── small helpers ────────────────────────────────────────────────────────
function clampInt(value, fallback, max, min = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
function str(value) {
    return typeof value === "string" ? value.trim() : "";
}

// Trim a full Lead down to the fields an agent actually reasons about in
// chat — keeps tool payloads small and predictable.
function trimLead(lead) {
    return {
        id: String(lead.id || lead._id),
        name: (lead.contact && lead.contact.name) || null,
        email: (lead.contact && lead.contact.email) || null,
        phone: (lead.contact && lead.contact.phone) || null,
        status: lead.status,
        temperature: lead.temperature,
        source: lead.source,
        assignedTo: lead.assignedTo || null,
        property: lead.property || null,
        tags: lead.tags || [],
        notes: lead.notes || null,
        createdAt: lead.createdAt,
        firstContactAt: lead.firstContactAt,
        lastContactAt: lead.lastContactAt,
        convertedAt: lead.convertedAt || null,
        lostAt: lead.lostAt || null,
    };
}

// Load a lead and enforce the shared visibility check in one place — every
// lead-sub-resource tool inherits get_lead's gate through this.
async function loadVisibleLead(actor, rawLeadId) {
    const leadId = str(rawLeadId);
    if (!isValidObjectId(leadId)) return { error: "not_found_or_no_access" };
    await connectToDatabase();
    const lead = await Lead.findById(leadId);
    if (!lead || !canActorSeeLead(actor, lead)) return { error: "not_found_or_no_access" };
    return { lead };
}

// ── tools ────────────────────────────────────────────────────────────────

async function runSearchLeads(actor, args = {}) {
    if (!INTERNAL_ROLES.includes(actor.role)) return { leads: [], count: 0, note: "no_access" };
    await connectToDatabase();

    const limit = clampInt(args.limit, 20, 50);
    const filter = { archivedAt: null };

    const query = str(args.query);
    if (query) {
        const pattern = new RegExp(escapeRegex(query), "i");
        filter.$or = [
            { "contact.name": pattern },
            { "contact.email": pattern },
            { "property.name": pattern },
            { "property.city": pattern },
        ];
    }
    if (args.status !== undefined && args.status !== null && args.status !== "") {
        if (!LEAD_STATUSES.includes(args.status)) {
            throw new Error(`status must be one of: ${LEAD_STATUSES.join(", ")}`);
        }
        filter.status = args.status;
    }
    if (args.assignedToMe) filter.assignedTo = String(actor._id);

    const staleDays = Number(args.staleDays);
    if (Number.isFinite(staleDays) && staleDays > 0) {
        const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
        filter.$and = [
            { $or: [{ lastContactAt: { $lt: cutoff } }, { lastContactAt: null }] },
            { createdAt: { $lt: cutoff } },
        ];
    }

    const docs = await Lead.find(filter).sort({ lastContactAt: 1, createdAt: -1 }).limit(limit);
    return { leads: docs.map(toSafeLead).map(trimLead), count: docs.length };
}

async function runGetLead(actor, args = {}) {
    const gate = await loadVisibleLead(actor, args.leadId);
    if (gate.error) return gate;
    const lead = gate.lead;

    const [followUps, communications, meetings] = await Promise.all([
        FollowUp.find({ leadId: lead._id }).sort({ dueAt: 1 }).limit(25),
        Communication.find({ leadId: lead._id }).sort({ createdAt: -1 }).limit(10),
        Meeting.find({ leadId: lead._id }).sort({ scheduledAt: -1 }).limit(10),
    ]);

    return {
        lead: trimLead(toSafeLead(lead)),
        followUps: followUps.map(followUpsRoute.toSafeFollowUp),
        recentCommunications: communications.map(communicationsRoute.toSafeCommunication),
        meetings: meetings.map(meetingsRoute.toSafeMeeting),
        counts: {
            followUps: followUps.length,
            pendingFollowUps: followUps.filter((f) => f.status === "pending").length,
            meetings: meetings.length,
        },
    };
}

async function runMyWorkQueue(actor, args = {}) {
    if (!INTERNAL_ROLES.includes(actor.role)) return { leads: [], count: 0, note: "no_access" };
    await connectToDatabase();

    const limit = clampInt(args.limit, 20, 50);
    const now = new Date();
    const todayStart = workQueueRoute.startOfDay(now);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // Actor-scoped: only this user's own assigned, non-archived leads.
    const baseMatch = workQueueRoute.buildBaseMatch({});
    baseMatch.assignedTo = String(actor._id);

    const enrichmentStages = workQueueRoute.buildEnrichmentStages(todayStart, tomorrowStart);
    const rankBranches = Object.entries(workQueueRoute.BUCKET_SORT_RANK).map(([bucket, rank]) => ({
        case: { $eq: ["$bucket", bucket] },
        then: rank,
    }));

    const rows = await Lead.aggregate([
        { $match: baseMatch },
        ...enrichmentStages,
        { $addFields: { _bucketRank: { $switch: { branches: rankBranches, default: 99 } } } },
        { $sort: { _bucketRank: 1, "nextFollowUp.dueAt": 1, createdAt: -1 } },
        { $limit: limit },
        {
            $project: {
                id: "$_id",
                _id: 0,
                contact: 1,
                status: 1,
                temperature: 1,
                source: 1,
                property: 1,
                createdAt: 1,
                lastContactAt: 1,
                lastInboundCommunicationAt: 1,
                nextFollowUp: 1,
                nextMeeting: 1,
                bucket: 1,
            },
        },
    ]);

    return {
        leads: rows.map((r) => ({
            id: String(r.id),
            name: (r.contact && r.contact.name) || null,
            status: r.status,
            temperature: r.temperature,
            bucket: r.bucket,
            nextFollowUp: r.nextFollowUp || null,
            nextMeeting: r.nextMeeting || null,
            lastContactAt: r.lastContactAt || null,
            lastInboundCommunicationAt: r.lastInboundCommunicationAt || null,
        })),
        count: rows.length,
    };
}

async function runGetLeadMeetings(actor, args = {}) {
    const gate = await loadVisibleLead(actor, args.leadId);
    if (gate.error) return gate;
    const meetings = await Meeting.find({ leadId: gate.lead._id }).sort({ scheduledAt: -1 });
    return { meetings: meetings.map(meetingsRoute.toSafeMeeting), count: meetings.length };
}

async function runGetLeadCommunications(actor, args = {}) {
    const gate = await loadVisibleLead(actor, args.leadId);
    if (gate.error) return gate;
    const limit = clampInt(args.limit, 20, 50);
    const communications = await Communication.find({ leadId: gate.lead._id }).sort({ createdAt: -1 }).limit(limit);
    return { communications: communications.map(communicationsRoute.toSafeCommunication), count: communications.length };
}

async function runGetLeadFollowUps(actor, args = {}) {
    const gate = await loadVisibleLead(actor, args.leadId);
    if (gate.error) return gate;
    const followUps = await FollowUp.find({ leadId: gate.lead._id }).sort({ dueAt: 1 });
    return { followUps: followUps.map(followUpsRoute.toSafeFollowUp), count: followUps.length };
}

const WEEKS_PER_MONTH = 52 / 12; // mirrors accommodationIndex.js's own constant

// Trim a raw AccommodationResidence doc (the shape getAccommodationInventory
// returns — lean Mongo docs, see AccommodationResidence.js) to the handful
// of fields the assistant reasons about. No neighbourhood field exists on
// the doc, so `area` is always null. The catalogue row carries only a
// distance-to-city-centre figure (no university-relative distance — that's
// computed per-query elsewhere and isn't in this data), so it's surfaced
// under an explicit key rather than a bare `distanceKm` the model would
// otherwise caption as "distance from <university>".
function trimResidence(doc) {
    const weekly = Number.isFinite(doc.priceWeekly) ? Math.round(doc.priceWeekly) : null;
    return {
        name: doc.propertyName || null,
        city: doc.city || null,
        area: null,
        priceWeekly: weekly,
        priceMonthly: weekly != null ? Math.round(weekly * WEEKS_PER_MONTH) : null,
        currency: (doc.price && doc.price.currency) || null,
        roomType: doc.roomType || null,
        url: doc.slug ? `/property/${doc.slug}` : null,
        distanceToCityCentreKm: Number.isFinite(doc.distanceToCentreKm)
            ? Math.round(doc.distanceToCentreKm * 10) / 10
            : null,
    };
}

// Backed by the IVYHUTS accommodation catalogue — the Amber-fed
// AccommodationResidence data the public University Housing page already
// presents as "IVYHUTS properties" — via accommodationInventoryService.js
// (market-area expansion included). Read-only, NOT actor-scoped.
async function runSearchProperties(actor, args = {}) {
    let city = null;
    let country = null;

    if (str(args.university)) {
        const r = await resolveUniversity(str(args.university).slice(0, MAX_QUERY_LENGTH));
        if (r && r.record && r.record.city) {
            city = r.record.city;
            country = r.record.country || null;
        }
    }
    if (!city && str(args.location)) city = str(args.location);
    if (!city) {
        return { properties: [], note: "Give me a city or a university name I can resolve to one." };
    }

    const inv = await getAccommodationInventory({ city });
    const rows = (inv && inv.residences) || [];
    if (!rows.length) {
        return { city, properties: [], totalFound: 0, note: `No IVYHUTS accommodation catalogued for ${city} yet.` };
    }

    const maxWeekly = Number(args.maxPricePerWeek);
    const hasMax = Number.isFinite(maxWeekly) && maxWeekly > 0;
    const roomNeedle = str(args.roomType).toLowerCase();

    let matched = rows.filter((doc) => {
        if (hasMax && Number.isFinite(doc.priceWeekly) && doc.priceWeekly > maxWeekly) return false;
        if (roomNeedle) {
            const hay = [doc.roomType, ...(Array.isArray(doc.roomTypes) ? doc.roomTypes : [])]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            if (!hay.includes(roomNeedle)) return false;
        }
        return true;
    });

    matched.sort((a, b) => {
        const pa = Number.isFinite(a.priceWeekly) ? a.priceWeekly : Infinity;
        const pb = Number.isFinite(b.priceWeekly) ? b.priceWeekly : Infinity;
        return pa - pb;
    });

    const limit = clampInt(args.limit, 10, 30);
    const properties = matched.slice(0, limit).map(trimResidence);

    const out = { city, properties, totalFound: matched.length, matchedFrom: rows.length };
    if (country) out.country = country;
    if (matched.length === 0) {
        out.note = `No listings in ${city} matched those filters (of ${rows.length} catalogued).`;
    }
    return out;
}

async function runResolveUniversity(actor, args = {}) {
    const query = str(args.query);
    if (!query) throw new Error("query is required");
    const result = await resolveUniversity(query.slice(0, MAX_QUERY_LENGTH));
    return {
        status: result.status,
        university: result.record || null,
        candidates: result.candidates || null,
        reason: result.reason || null,
    };
}

function runLookupCostOfLiving(actor, args = {}) {
    const city = str(args.city) || str(args.location) || null;
    const country = str(args.country) || null;
    if (!city && !country) throw new Error("city or country is required");
    return getCityLivingCost(city, country);
}

function findCareerId(role) {
    const r = String(role || "").trim().toLowerCase();
    if (!r) return null;
    const exact = CAREERS.find((c) => c.title.toLowerCase() === r);
    if (exact) return exact.id;
    const slug = CAREERS.find((c) => c.id === r.replace(/\s+/g, "-"));
    if (slug) return slug.id;
    const partial = CAREERS.find(
        (c) => c.title.toLowerCase().includes(r) || r.includes(c.title.toLowerCase())
    );
    return partial ? partial.id : null;
}

function runLookupSalaries(actor, args = {}) {
    const role = str(args.role);
    const country = str(args.country);
    const careerId = findCareerId(role);
    if (!careerId) {
        return {
            available: false,
            note: "No matching role in the curated salary guidance. Provide a specific job title (e.g. \"Software Engineer\").",
            knownRolesSample: CAREERS.slice(0, 12).map((c) => c.title),
        };
    }
    const result = resolveSalaryForCareer({ careerId, country });
    return { role: role || null, matchedCareer: careerId, ...result };
}

// ── registry ─────────────────────────────────────────────────────────────
const REGISTRY = {
    search_leads: {
        run: runSearchLeads,
        def: {
            name: "search_leads",
            description:
                "Search the CRM's leads (student-accommodation prospects). Returns a trimmed list. Only leads the current user is allowed to see are returned; a non-internal user gets nothing. Use staleDays to find leads with no recent contact ('gone cold').",
            input_schema: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Free text matched against contact name/email and property name/city." },
                    status: { type: "string", enum: LEAD_STATUSES, description: "Filter by pipeline status." },
                    assignedToMe: { type: "boolean", description: "Only leads assigned to the current user." },
                    staleDays: { type: "number", description: "Only leads created more than this many days ago AND not contacted within that window." },
                    limit: { type: "number", description: "Max results, 1-50 (default 20)." },
                },
            },
        },
    },
    get_lead: {
        run: runGetLead,
        def: {
            name: "get_lead",
            description:
                "Get one lead's detail plus its follow-ups, recent communications and meetings. Returns { error: 'not_found_or_no_access' } if the lead does not exist or the current user cannot see it.",
            input_schema: {
                type: "object",
                properties: { leadId: { type: "string", description: "The lead's id." } },
                required: ["leadId"],
            },
        },
    },
    my_work_queue: {
        run: runMyWorkQueue,
        def: {
            name: "my_work_queue",
            description:
                "The current user's prioritized work queue: their own assigned leads, each tagged with a work bucket (overdue, meetingToday, today, discoveryIncomplete, readyForFindRooms, ...), highest priority first.",
            input_schema: {
                type: "object",
                properties: { limit: { type: "number", description: "Max results, 1-50 (default 20)." } },
            },
        },
    },
    get_lead_meetings: {
        run: runGetLeadMeetings,
        def: {
            name: "get_lead_meetings",
            description: "List every meeting for a lead, most recent first. Inherits get_lead's access check.",
            input_schema: {
                type: "object",
                properties: { leadId: { type: "string" } },
                required: ["leadId"],
            },
        },
    },
    get_lead_communications: {
        run: runGetLeadCommunications,
        def: {
            name: "get_lead_communications",
            description: "List a lead's logged communications (calls, WhatsApp, email records), most recent first. Inherits get_lead's access check.",
            input_schema: {
                type: "object",
                properties: {
                    leadId: { type: "string" },
                    limit: { type: "number", description: "Max results, 1-50 (default 20)." },
                },
                required: ["leadId"],
            },
        },
    },
    get_lead_follow_ups: {
        run: runGetLeadFollowUps,
        def: {
            name: "get_lead_follow_ups",
            description: "List a lead's follow-up actions (due dates, priority, status). Inherits get_lead's access check.",
            input_schema: {
                type: "object",
                properties: { leadId: { type: "string" } },
                required: ["leadId"],
            },
        },
    },
    search_properties: {
        run: runSearchProperties,
        def: {
            name: "search_properties",
            description:
                "Search the IVYHUTS student-accommodation catalogue by city, or by a university name (resolved to its city first). UK inventory.",
            input_schema: {
                type: "object",
                properties: {
                    university: { type: "string", description: "University name to search near." },
                    location: { type: "string", description: "City/area, if no university." },
                    maxPricePerWeek: { type: "number", description: "Upper bound on weekly rent." },
                    roomType: { type: "string", description: "e.g. 'studio', 'ensuite', 'non-ensuite'." },
                    limit: { type: "number", description: "Max results, 1-30 (default 10)." },
                },
            },
        },
    },
    resolve_university: {
        run: runResolveUniversity,
        def: {
            name: "resolve_university",
            description:
                "Resolve free text (possibly misspelled or an abbreviation) to a canonical university record with city/country. Status may be 'resolved', 'ambiguous' (candidates), or 'not_found'.",
            input_schema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
            },
        },
    },
    lookup_cost_of_living: {
        run: runLookupCostOfLiving,
        def: {
            name: "lookup_cost_of_living",
            description:
                "Curated monthly student cost-of-living estimate (food, transport, utilities, personal, other) for a city/country. Planning figures, not official statistics.",
            input_schema: {
                type: "object",
                properties: {
                    city: { type: "string" },
                    country: { type: "string" },
                },
            },
        },
    },
    lookup_salaries: {
        run: runLookupSalaries,
        def: {
            name: "lookup_salaries",
            description:
                "Curated post-study salary guidance ranges for a job title in a country (entry / early / mid / experienced). Estimates, not official data.",
            input_schema: {
                type: "object",
                properties: {
                    role: { type: "string", description: "Job title, e.g. 'Software Engineer'." },
                    country: { type: "string" },
                },
            },
        },
    },
};

const TOOLS = Object.values(REGISTRY).map((t) => t.def);

async function runTool(name, actor, args) {
    const entry = REGISTRY[name];
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    return entry.run(actor, args || {});
}

// Short, human-readable one-liner for the SSE `tool_result` event — never
// the full payload.
function summarizeToolResult(name, result) {
    if (result && result.error === "not_found_or_no_access") return "Lead not found, or you don't have access to it.";
    if (result && result.note === "no_access") return "You don't have access to CRM leads.";
    switch (name) {
        case "search_leads":
            return `Found ${result.count} lead${result.count === 1 ? "" : "s"}.`;
        case "get_lead":
            return result.lead ? `Loaded lead ${result.lead.name || result.lead.id}.` : "No lead.";
        case "my_work_queue":
            return `${result.count} lead${result.count === 1 ? "" : "s"} in your queue.`;
        case "get_lead_meetings":
            return `${result.count} meeting${result.count === 1 ? "" : "s"}.`;
        case "get_lead_communications":
            return `${result.count} communication${result.count === 1 ? "" : "s"}.`;
        case "get_lead_follow_ups":
            return `${result.count} follow-up${result.count === 1 ? "" : "s"}.`;
        case "search_properties": {
            if (result.note && !(result.properties || []).length) return result.note;
            const shown = (result.properties || []).length;
            const total = result.totalFound ?? shown;
            return `${shown} of ${total} matching listing${total === 1 ? "" : "s"} in ${result.city}.`;
        }
        case "resolve_university":
            return `University lookup: ${result.status}.`;
        case "lookup_cost_of_living":
            return result.matched ? `Cost-of-living figures for ${result.city}.` : "Cost-of-living fallback figures.";
        case "lookup_salaries":
            return result.available ? `Salary guidance for ${result.matchedCareer}.` : "No salary guidance match.";
        default:
            return "Done.";
    }
}

module.exports = { TOOLS, runTool, summarizeToolResult, REGISTRY };
