// Only present groups are displayed; saved groups absent from this view stay private.
export function orderedGroups(groups: string[], order: string[] = []) {
  const present = new Set(groups);
  return [...order.filter((g) => present.delete(g)), ...present];
}
export function mergeGroupOrder(visible: string[], saved: string[]) {
  return [...visible, ...saved.filter((g) => !visible.includes(g))];
}
