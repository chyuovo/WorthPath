const pages = [
  'overview',
  'calendar',
  'account',
  'asset',
  'debt',
  'history',
  'settings',
  'schedules',
  'admin',
];
const sections = [
  'general',
  'display',
  'privacy',
  'security',
  'agent',
  'icons',
  'rates',
  'backup',
  'clear',
];
export function savedDefaultPage() {
  try {
    const value = localStorage.getItem('worthpath.defaultPage');
    return value && pages.includes(value) ? value : 'overview';
  } catch {
    return 'overview';
  }
}
export function saveDefaultPage(page: string) {
  if (!pages.includes(page)) return;
  try {
    localStorage.setItem('worthpath.defaultPage', page);
  } catch {
    /* Preference remains available for this session. */
  }
}
export function initialPage() {
  if (new URLSearchParams(location.search).has('agent_authorization')) return 'agent-review';
  const page = location.hash.slice(1).split('/')[0];
  return pages.includes(page) ? page : savedDefaultPage();
}
export function initialSettingsSection() {
  const [page, section] = location.hash.slice(1).split('/');
  return page === 'settings' && sections.includes(section) ? section : '';
}
export function persistPage(page: string, section: string) {
  if (!pages.includes(page)) return;
  const hash =
    '#' + page + (page === 'settings' && sections.includes(section) ? '/' + section : '');
  if (location.hash !== hash)
    history.replaceState(null, '', location.pathname + location.search + hash);
}
