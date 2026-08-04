const PARTNER_ID = "ivy-huts-707a5cdf";

const BASE_URL = `https://base.amberstudent.com/api/v0/leads/partners/${PARTNER_ID}`;

async function fetchJson(url) {
    console.log("Amber: fetching", url);
    const res = await fetch(url);
    console.log("Amber: response status", res.status);
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("Amber fetch failed:", res.status, text);
        throw new Error("Failed to fetch properties");
    }
    try {
        const json = await res.json();
        console.log("Amber: raw json", json);
        return json;
    } catch (err) {
        console.error("Amber: invalid json", err);
        throw err;
    }
}

function findFirstArray(obj) {
    if (!obj || typeof obj !== "object") return null;
    for (const k of Object.keys(obj)) {
        if (Array.isArray(obj[k])) return obj[k];
        if (obj[k] && typeof obj[k] === "object") {
            const nested = findFirstArray(obj[k]);
            if (nested) return nested;
        }
    }
    return null;
}

function extractArray(json) {
    if (!json) return [];
    if (Array.isArray(json)) return json;
    if (json.data) {
        if (Array.isArray(json.data)) return json.data;
        if (Array.isArray(json.data.result)) return json.data.result;
        if (Array.isArray(json.data.results)) return json.data.results;
        if (Array.isArray(json.data.inventories)) return json.data.inventories;
    }
    if (Array.isArray(json.result)) return json.result;
    if (Array.isArray(json.results)) return json.results;
    if (Array.isArray(json.inventories)) return json.inventories;

    
    const anyArray = findFirstArray(json);
    return anyArray || [];
}

export async function getProperties(city, page = 1, limit = 20) {
    const baseUrl = `${BASE_URL}/inventories?p=${page}&limit=${limit}`;

   
    if (city) {
        const filteredUrl = `${baseUrl}&location_place_name=${encodeURIComponent(city)}`;
        try {
            const json = await fetchJson(filteredUrl);
            const arr = extractArray(json);
            
            if (Array.isArray(arr) && arr.length > 0) {
                console.log(`Amber: returning ${arr.length} filtered items`);
                return arr;
            }
            
            console.log("Amber: filtered request returned no items, will fetch unfiltered and filter on client");
        } catch (err) {
            console.error("Amber: filtered request failed, will fallback to unfiltered fetch", err);
        }
    }

   
    const json = await fetchJson(baseUrl);
    let arr = extractArray(json);

    // If a city was requested, and server-side filtering returned nothing or isn't supported,
    // perform a best-effort client-side filter by checking common location fields.
    if (city && Array.isArray(arr)) {
        const cityLower = city.toLowerCase();
        const filtered = arr.filter((item) => {
            try {
                const checks = [];
                if (item.location) {
                    if (item.location.locality && item.location.locality.long_name) checks.push(item.location.locality.long_name);
                    if (item.location.city && item.location.city.long_name) checks.push(item.location.city.long_name);
                    if (item.location.country && item.location.country.long_name) checks.push(item.location.country.long_name);
                }
                if (item.name) checks.push(item.name);
                if (item.address) {
                    if (typeof item.address === "string") checks.push(item.address);
                    if (item.address.locality) checks.push(item.address.locality);
                }
                return checks.some((s) => typeof s === "string" && s.toLowerCase().includes(cityLower));
            } catch (e) {
                return false;
            }
        });
        console.log(`Amber: client-side filtered ${arr.length} -> ${filtered.length} items for city="${city}"`);
        arr = filtered;
    }

    return Array.isArray(arr) ? arr : [];
}