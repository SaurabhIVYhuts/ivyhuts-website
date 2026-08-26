// Route table for the consolidated /api/auth/** dispatcher
// (api/auth/[[...path]].js). All four handlers are unmodified from their
// original api/auth/*.js versions, just relocated. None share a dynamic
// URL segment — dispatch is purely by the literal path segment
// (login/logout/me/signup); each handler still checks req.method itself.
module.exports = [
    { segments: ["login"], handler: require("./auth/login.js") },
    { segments: ["logout"], handler: require("./auth/logout.js") },
    { segments: ["me"], handler: require("./auth/me.js") },
    { segments: ["signup"], handler: require("./auth/signup.js") },
];
