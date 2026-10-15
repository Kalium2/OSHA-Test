/**
 * Site configuration. Edit this file, not index.html.
 *
 * apiBase: the deployed Cloudflare Worker that proxies the DOL OSHA API.
 *          A ?api=... query parameter overrides it for one page load.
 */
window.VIOLATIONS_DESK_CONFIG = {
  apiBase: 'https://violations-desk-osha.workers.dev'
};
