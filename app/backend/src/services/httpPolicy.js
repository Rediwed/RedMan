export function fetchWithoutRedirect(url, options = {}) {
  return fetch(url, { ...options, redirect: 'error' });
}