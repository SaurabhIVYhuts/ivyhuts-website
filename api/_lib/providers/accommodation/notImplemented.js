// Shared "not configured" adapter factory. Used by all four provider
// adapters today (see README.md) — no verified public API exists for any
// of UHomes/UniAcco/University Living/Gradding Homes (Milestone 23.2
// audit), and this milestone explicitly forbids scraping/reverse
// engineering/fabricated results. Never fabricates properties and never
// invents an endpoint.
function createNotConfiguredAdapter(provider, reason) {
    return {
        provider,
        async search() {
            return { provider, status: "NOT_CONFIGURED", properties: [], reason };
        },
    };
}

module.exports = { createNotConfiguredAdapter };
