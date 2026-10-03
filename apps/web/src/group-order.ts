// Only present groups are displayed; saved groups absent from this view stay private.
export function orderedGroups(groups: string[], order: string[] = []) {
  const present = new Set(groups);
  return [...order.filter((g) => present.delete(g)), ...present];
}
export function mergeGroupOrder(visible: string[], saved: string[]) {
  return [...visible, ...saved.filter((g) => !visible.includes(g))];
}

export function moveGroup(groups: string[], from: number, to: number) {
  if (from === to || from < 0 || to < 0 || from >= groups.length || to >= groups.length)
    return groups;
  const next = [...groups],
    [group] = next.splice(from, 1);
  next.splice(to, 0, group);
  return next;
}
