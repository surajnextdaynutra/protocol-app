/* Rx Portal - loads the dashboard script (rx-dash.js) only when a dashboard
   block is on the page. The block prints the script's URL on its mount. */
(function () {
  function load() {
    var el = document.querySelector('[data-rx-dash][data-rx-src]');
    if (!el || window.__rxDashRequested) return;
    window.__rxDashRequested = true;
    var s = document.createElement('script');
    s.src = el.getAttribute('data-rx-src');
    s.async = true;
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
  document.addEventListener('shopify:section:load', load);
})();
