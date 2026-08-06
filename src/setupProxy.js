// CRA's documented convention: automatically picked up by `react-scripts
// start` to proxy requests during local development. Forwards /api/* to the
// local Amber gateway server (scripts/local-api-server.js), which runs the
// exact same api/amber.js handler Vercel runs in production.
const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (app) {
  app.use(
    "/api",
    createProxyMiddleware({
      target: `http://localhost:${process.env.LOCAL_API_PORT || 3001}`,
      changeOrigin: true,
    })
  );
};