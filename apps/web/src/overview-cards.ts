export const overviewCardLabels = {
  assets: '总资产',
  liabilities: '总负债',
  net: '净资产',
  trend: '净资产轨迹',
  recent: '最近变化',
  attribution: '变化归因',
};
export type OverviewCard = keyof typeof overviewCardLabels;
export const allOverviewCards = Object.keys(overviewCardLabels) as OverviewCard[];
