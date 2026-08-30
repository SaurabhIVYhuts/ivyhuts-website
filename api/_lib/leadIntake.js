// Shared Lead intake normalization — Milestone 23.14.
//
// One normalizer, reusable across every current and future Lead source
// (Google Sheet import today; the same shape api/leads/meta/webhook.js
// already produces for a live webhook; a future website/manual source
// could reuse mergeLeadFillMissing too) — see this repo's own architecture
// note: "the same Lead normalization pipeline should be reusable... without
// changing the Lead model later." This file is that reusable core.
//
// normalizeMetaSheetRow() is built directly against the ACTUAL columns of
// the real Meta Ads lead-export sheet inspected while designing this
// feature (id, created_time, ad_id, ad_name, adset_id, adset_name,
// campaign_id, campaign_name, form_id, form_name, is_organic, platform,
// email, phone_number, first_name, last_name, lead_status) — not invented.
// Two real, non-hypothetical data-quality issues were found in that real
// sheet and are handled explicitly below:
//   1. Meta always sends one synthetic "test lead" per verified form
//      (email "test@meta.com", placeholder text in every name/phone field,
//      no ad/campaign data) — detected and skipped, never imported as a
//      real prospect.
//   2. When the sheet's own upstream sync tool lacks permission to read an
//      ad/campaign/adset's name, it writes Facebook's own API error text
//      ("You don't have enough permission...") into that cell AS IF it
//      were real data — detected and nulled out rather than stored as a
//      fabricated campaign/ad name.
"use strict";

// Meta's Lead Ads export/sync tools prefix each id-shaped field with a
// short type tag (l: lead, ag: ad, as: adset, c: campaign, f: form,
// p: phone) — stripped here so externalLeadId matches EXACTLY the raw
// numeric leadgen_id the real Meta webhook already stores (see
// api/leads/meta/webhook.js: `externalLeadId: value.leadgen_id`), which is
// required for a lead delivered via both the sheet AND a future live
// webhook to dedupe as the SAME Lead, not two.
function stripIdPrefix(value) {
    const s = String(value || "").trim();
    const match = /^[a-z]{1,2}:(.+)$/.exec(s);
    return match ? match[1] : s;
}

// Facebook's own Graph API permission-error text, observed verbatim in the
// real sheet's ad_id/ad_name/adset_id/adset_name/campaign_id/campaign_name
// cells when the sync tool's token lacked ad-account read access. Treated
// as "this field's value is unavailable", never stored as if it were a
// real name/id — storing it verbatim would silently corrupt attribution
// data with API error prose.
function isPermissionErrorText(value) {
    return typeof value === "string" && value.toLowerCase().includes("enough permission");
}

function cleanField(value) {
    if (value === undefined || value === null) return null;
    const stripped = stripIdPrefix(value);
    if (!stripped || isPermissionErrorText(stripped)) return null;
    return stripped;
}

// Meta's own per-form verification test lead — real, well-documented Meta
// behavior (sent once when a lead form is created/verified), not a guess.
// Two independent, corroborating signals required so a real prospect named
// e.g. "Test" is never mistakenly skipped: the literal placeholder text
// Meta embeds in every name/phone field, OR the exact reserved test email.
function isMetaTestLead(row) {
    const placeholderPattern = /dummy data for/i;
    const hasPlaceholderText = placeholderPattern.test(row.first_name || "") || placeholderPattern.test(row.last_name || "") || placeholderPattern.test(row.phone_number || "");
    const isTestEmail = String(row.email || "").trim().toLowerCase() === "test@meta.com";
    return hasPlaceholderText || isTestEmail;
}

// Returns null (row should be skipped, e.g. Meta's test lead) or a
// normalized intake object: { externalLeadId, contact, source,
// sourceDetails }. Never throws — a malformed row degrades to whatever
// fields are actually present rather than failing the whole import batch.
function normalizeMetaSheetRow(row) {
    if (isMetaTestLead(row)) return null;

    const externalLeadId = cleanField(row.id);
    if (!externalLeadId) return null; // no usable dedup key at all — cannot safely import this row

    const firstName = String(row.first_name || "").trim();
    const lastName = String(row.last_name || "").trim();
    const name = [firstName, lastName].filter(Boolean).join(" ").trim() || null;
    const email = String(row.email || "").trim().toLowerCase() || null;
    const phone = cleanField(row.phone_number);

    return {
        externalLeadId,
        contact: { name, email, phone },
        source: "facebook_lead_ads", // same value the live webhook uses — the sheet is a transport, not a different channel
        sourceDetails: {
            formId: cleanField(row.form_id),
            adId: cleanField(row.ad_id),
            campaignId: cleanField(row.campaign_id),
            pageId: null, // the sheet has no page_id column at all — confirmed absent, never fabricated
            // Extra attribution the sheet provides beyond the webhook's own
            // shape — sourceDetails is a Mixed field, so these are additive,
            // not a schema change (Part 6: "store them under the existing
            // source-details mechanism").
            adName: cleanField(row.ad_name),
            campaignName: cleanField(row.campaign_name),
            adsetId: cleanField(row.adset_id),
            adsetName: cleanField(row.adset_name),
            platform: cleanField(row.platform) || null,
            isOrganic: row.is_organic === "true" ? true : row.is_organic === "false" ? false : null,
            metaCreatedTime: String(row.created_time || "").trim() || null,
            importedVia: "google_sheet",
        },
    };
}

// Fill-missing-only merge — Part 5's "external source data -> fill missing
// fields -> never silently overwrite stronger CRM data". Deliberately NOT
// used by the live Meta webhook (api/leads/meta/webhook.js), which keeps
// its own simpler, already-tested "redelivery is a pure no-op" contract —
// see this file's header comment; a periodic sheet sync can plausibly gain
// new information about an existing row over time (someone re-runs the
// sync after fixing a permission issue upstream, for example), which is a
// meaningfully different situation from a webhook literally redelivering
// the identical payload, so the two sources get different, deliberately
// chosen merge policies rather than one forced to fit both.
//
// Mutates nothing — returns the set of $set updates to apply, or null if
// there is nothing missing to fill. Only ever fills a field that is
// currently null/empty on the existing Lead; a field the CRM already has
// any value for (however that value got there) is never touched.
function computeFillMissingUpdate(existingLead, incoming) {
    const set = {};
    if (!existingLead.contact || !existingLead.contact.name) {
        if (incoming.contact.name) set["contact.name"] = incoming.contact.name;
    }
    if (!existingLead.contact || !existingLead.contact.email) {
        if (incoming.contact.email) set["contact.email"] = incoming.contact.email;
    }
    if (!existingLead.contact || !existingLead.contact.phone) {
        if (incoming.contact.phone) set["contact.phone"] = incoming.contact.phone;
    }
    if (!existingLead.source) set.source = incoming.source;

    // sourceDetails: fill only keys that are currently absent/null on the
    // existing document — an existing (even different) value always wins.
    const existingDetails = (existingLead.sourceDetails && typeof existingLead.sourceDetails === "object") ? existingLead.sourceDetails : {};
    let sourceDetailsChanged = false;
    const mergedDetails = { ...existingDetails };
    for (const [key, value] of Object.entries(incoming.sourceDetails)) {
        if (value === null || value === undefined) continue;
        if (existingDetails[key] === undefined || existingDetails[key] === null || existingDetails[key] === "") {
            mergedDetails[key] = value;
            sourceDetailsChanged = true;
        }
    }
    if (sourceDetailsChanged) set.sourceDetails = mergedDetails;

    return Object.keys(set).length > 0 ? set : null;
}

module.exports = {
    stripIdPrefix,
    isPermissionErrorText,
    isMetaTestLead,
    normalizeMetaSheetRow,
    computeFillMissingUpdate,
};
