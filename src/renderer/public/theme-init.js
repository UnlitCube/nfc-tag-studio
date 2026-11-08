// Runs before first paint (plain script, copied as-is by Vite). Applies the theme
// the app last resolved (mirrored to localStorage by the renderer), else the OS one.
(function () {
  var theme = null;
  try {
    theme = localStorage.getItem('nfcts-resolved-theme');
  } catch (e) {
    theme = null;
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
