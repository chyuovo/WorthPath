export const accountPages = ['account', 'asset', 'debt'] as const;
export const overviewPages = ['overview', 'history'] as const;
export const settingsPages = ['settings', 'schedules', 'admin'] as const;

export function navigationGroup(page: string) {
  if ((accountPages as readonly string[]).includes(page)) return 'account';
  if ((overviewPages as readonly string[]).includes(page)) return 'overview';
  if ((settingsPages as readonly string[]).includes(page)) return 'settings';
  return page;
}

export function availablePages(pages: readonly string[], hidden: string[], role?: string) {
  return pages.filter((page) =>
    page === 'settings' ? true : page === 'admin' ? role === 'admin' : !hidden.includes(page),
  );
}

export function navigationDestination(group: string, hidden: string[], role?: string) {
  const pages =
    group === 'account'
      ? accountPages
      : group === 'overview'
        ? overviewPages
        : group === 'settings'
          ? settingsPages
          : [group];
  return availablePages(pages, hidden, role)[0];
}
