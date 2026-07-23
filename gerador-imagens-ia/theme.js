/* Shared dark-mode module for the Drossi Kit de Ferramentas.
   Include as early as possible (right after <meta charset>) so the theme
   is applied before first paint — avoids a flash of the wrong theme.
   Persists via localStorage; syncs across pages on this origin automatically,
   and across origins (e.g. the local VideoPress server) via a ?theme= param
   appended to outbound links — see applyThemeLinks() below. */
(function () {
  var KEY = 'drossi-theme';

  function getStored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function setStored(t) {
    try { localStorage.setItem(KEY, t); } catch (e) {}
  }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
  }

  var params = new URLSearchParams(location.search);
  var urlTheme = params.get('theme');
  var theme = (urlTheme === 'dark' || urlTheme === 'light') ? urlTheme : getStored();
  if (theme !== 'dark' && theme !== 'light') {
    theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }
  apply(theme);
  setStored(theme);

  if (urlTheme) {
    params.delete('theme');
    var qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  window.DrossiTheme = {
    get: function () { return document.documentElement.getAttribute('data-theme') || 'light'; },
    set: function (t) {
      apply(t); setStored(t);
      document.dispatchEvent(new CustomEvent('drossi-theme-change', { detail: t }));
    },
    toggle: function () {
      var next = window.DrossiTheme.get() === 'dark' ? 'light' : 'dark';
      window.DrossiTheme.set(next);
      return next;
    },
    // Appends the current theme as a ?theme= param to every link matching
    // the selector, so navigating to a different origin (VideoPress) carries
    // the preference along instead of losing it.
    applyThemeLinks: function (selector) {
      var t = window.DrossiTheme.get();
      document.querySelectorAll(selector).forEach(function (a) {
        try {
          var u = new URL(a.getAttribute('href'), location.href);
          u.searchParams.set('theme', t);
          a.setAttribute('href', u.pathname + u.search + u.hash + (u.origin !== location.origin ? '' : ''));
          if (u.origin !== location.origin) a.setAttribute('href', u.toString());
        } catch (e) {}
      });
    }
  };

  window.addEventListener('storage', function (e) {
    if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) apply(e.newValue);
  });
})();
