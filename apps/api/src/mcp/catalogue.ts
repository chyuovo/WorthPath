import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { UserRequest } from '../auth';
import { PortfolioBusinessService } from '../portfolio';
import { TransfersBusinessService } from '../transfers';
import { SchedulesBusinessService, scheduleInput } from '../schedules';
import { CalendarBusinessService } from '../calendar';
import { SettingsBusinessService } from '../rates';
import { MetalsBusinessService, metalConfig, metalHoldingInput, metalPriceInput } from '../metals';
import { IconsBusinessService } from '../icons';
import { BackupBusinessService } from '../backup';
import {
  positionInput,
  positionMeta,
  revisionInput,
  transferInput,
  settingsInput,
  date,
  currencies,
} from '../validation';

const id = z.string().uuid().describe('稳定对象 UUID；名称重名时先搜索，再由用户选择 ID');
export const empty = z.object({}).strict();
const pageFields = {
  limit: z.number().int().min(1).max(100).default(50).describe('单页上限 100'),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1000000)
    .default(0)
    .describe('列表偏移；数据变化后从第一页重读'),
};
const historyFields = {
  limit: pageFields.limit,
  cursor: z.string().max(512).optional().describe('上一页 nextCursor'),
  from: date.optional(),
  to: date.optional(),
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
export function page<T>(items: T[], p: { limit: number; offset: number }) {
  return {
    items: items.slice(p.offset, p.offset + p.limit),
    total: items.length,
    nextOffset: p.offset + p.limit < items.length ? p.offset + p.limit : null,
  };
}
export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodObject<any>;
  scope: 'read' | 'write' | 'sensitive';
  destructive?: boolean;
  web?: 'credentials' | 'reveal' | 'clear';
  run?: (r: UserRequest, p: any) => Promise<unknown>;
};
@Injectable()
export class AgentCatalogue {
  readonly tools: ToolDefinition[];
  constructor(
    portfolio: PortfolioBusinessService,
    transfers: TransfersBusinessService,
    schedules: SchedulesBusinessService,
    calendar: CalendarBusinessService,
    settings: SettingsBusinessService,
    metals: MetalsBusinessService,
    icons: IconsBusinessService,
    backup: BackupBusinessService,
  ) {
    const read = (
      name: string,
      description: string,
      schema: z.ZodObject<any>,
      run: ToolDefinition['run'],
    ): ToolDefinition => ({ name, description, schema, scope: 'read', run });
    const write = (
      name: string,
      description: string,
      schema: z.ZodObject<any>,
      run: ToolDefinition['run'],
      destructive = false,
    ): ToolDefinition => ({ name, description, schema, scope: 'write', run, destructive });
    this.tools = [
      read(
        'positions_list',
        '查询账户、独立资产、借入借出债务。原币余额字符串；负债账户正数为欠款、负数为溢缴。支持名称搜索，重名不自动选择。',
        z
          .object({
            ...pageFields,
            kind: z.enum(['account', 'asset', 'debt']).optional(),
            q: z.string().max(100).optional(),
            archived: z.boolean().optional(),
            side: z.enum(['asset', 'liability']).optional(),
            currency: z.enum(currencies).optional(),
            groupName: z.string().max(60).optional(),
            order: z.enum(['name', 'id']).default('id'),
          })
          .strict(),
        async (r, p) => {
          const rows = (await portfolio.list(r, p.kind)).filter(
            (v) =>
              (!p.q || v.name.includes(p.q)) &&
              (p.archived === undefined || p.archived === v.archived) &&
              (!p.side || p.side === v.side) &&
              (!p.currency || p.currency === v.currency) &&
              (p.groupName === undefined || p.groupName === v.groupName),
          );
          rows.sort(
            (a, b) =>
              (p.order === 'name' ? a.name.localeCompare(b.name) : 0) || a.id.localeCompare(b.id),
          );
          return page(rows, p);
        },
      ),
      read(
        'position_get',
        '查询项目详情、配置和当前原币余额。隐藏项目需网页解锁。',
        z.object({ id }).strict(),
        (r, p) => portfolio.detail(r, p.id),
      ),
      write(
        'position_create',
        '新增账户、独立资产或债务及初始绝对余额。金额为十进制字符串，业务 date 为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm（UTC+8）。不新增日常消费功能。',
        positionInput,
        (r, p) => portfolio.create(r, p),
      ),
      write(
        'position_update',
        '修改名称、分类、分组、图标、备注、归档、隐藏、统计开关；币种和资产负债属性固定。须提供完整元数据。',
        z.object({ id, data: positionMeta }).strict(),
        (r, p) => portfolio.edit(r, p.id, p.data),
      ),
      write(
        'balance_record',
        '新增余额/估值/负债调整/单边还款历史：amount 是变更后的绝对余额，不是增量。资产估值使用 valuation；配对转账和还款使用 movement_create。',
        z.object({ id, data: revisionInput }).strict(),
        (r, p) => portfolio.revise(r, p.id, p.data),
      ),
      read(
        'history_list',
        '分页查询全局或单项目历史，业务时间降序；返回真实前序余额。',
        z.object({ ...historyFields, positionId: id.optional() }).strict(),
        (r, p) => portfolio.history(r, p),
      ),
      write(
        'history_update',
        '更正单条非配对历史，自动重放后续金额；配对记录使用 movement_update。',
        z.object({ id, revisionId: id, data: revisionInput }).strict(),
        (r, p) => portfolio.correct(r, p.id, p.revisionId, p.data),
      ),
      write(
        'history_delete',
        '删除历史并重算；配对历史会撤销完整双边操作。',
        z.object({ id, revisionId: id }).strict(),
        (r, p) => portfolio.deleteRevision(r, p.id, p.revisionId),
        true,
      ),
      write(
        'debt_links_set',
        '替换债务与自己账户/资产的关联，不参与金额求和。',
        z.object({ id, targetIds: z.array(id).max(20) }).strict(),
        (r, p) => portfolio.link(r, p.id, { targetIds: p.targetIds }),
      ),
      read(
        'overview_get',
        '净资产、资产负债总额、结构及变化归因；遵循逐项目和独立资产纳入设置。明细分页。',
        z.object(pageFields).strict(),
        async (r, p) => {
          const v = await portfolio.overview(r);
          return { ...v, ...page(v.items, p) };
        },
      ),
      read(
        'trend_get',
        '净资产趋势，缺失汇率不绘制完整总额。业务日 YYYY-MM-DD；支持日/周/月粒度。',
        z
          .object({
            from: date.optional(),
            to: date.optional(),
            grain: z.enum(['day', 'week', 'month']).optional(),
          })
          .strict(),
        (r, p) => portfolio.trend(r, p),
      ),
      read(
        'movements_list',
        '查询转账、借入、借出、收款、还款配对记录，分页和业务日期筛选。',
        z.object(historyFields).strict(),
        (r, p) => transfers.list(r, p),
      ),
      read(
        'movement_by_revision',
        '根据历史 UUID 找到对应双边记录。',
        z.object({ revisionId: id }).strict(),
        (r, p) => transfers.byRevision(r, p.revisionId),
      ),
      write(
        'movement_create',
        '执行 transfer 转账、borrow 借入、lend 借出、collect 收款、repay 还款。amount 为本金，received 为到账/债务本金，fee 可负表示优惠；原币十进制字符串，双边事务和余额检查。',
        transferInput.safeExtend({ requestId: z.never().optional() }),
        (r, p) => transfers.create(r, p),
      ),
      write(
        'movement_update',
        '修改完整双边资金往来并重放后续历史，保持余额一致。',
        z
          .object({ id, data: transferInput.safeExtend({ requestId: z.never().optional() }) })
          .strict(),
        (r, p) => transfers.edit(r, p.id, p.data),
      ),
      write(
        'movement_delete',
        '撤销完整双边转账/借贷/还款并重算后续余额。',
        z.object({ id }).strict(),
        (r, p) => transfers.remove(r, p.id),
        true,
      ),
      read(
        'calendar_month',
        '月日历现金流统计；YYYY-MM，时区 UTC+8。',
        z
          .object({
            month: z
              .string()
              .regex(/^\d{4}-\d{2}$/)
              .optional(),
          })
          .strict(),
        (r, p) => calendar.month(r, p.month),
      ),
      read(
        'calendar_day',
        '查询某业务日的收入支出变化明细，分页。',
        z.object({ ...pageFields, date: date.optional() }).strict(),
        async (r, p) => {
          const v = await calendar.day(r, p.date);
          return { ...v, ...page(v.items, p) };
        },
      ),
      read(
        'schedules_list',
        '计划列表及启用、完成状态，按到期时间排序。执行记录也可在 history_list 查询。',
        z.object(pageFields).strict(),
        async (r, p) => page(await schedules.list(r), p),
      ),
      write(
        'schedule_create',
        '新增现有支出或转账计划。nextAt 为 YYYY-MM-DDTHH:mm（UTC+8），intervalDays=0 表示一次。',
        scheduleInput,
        (r, p) => schedules.create(r, p),
      ),
      write(
        'schedule_update',
        '修改未完成计划的完整配置。',
        z.object({ id, data: scheduleInput }).strict(),
        (r, p) => schedules.edit(r, p.id, p.data),
      ),
      write(
        'schedule_toggle',
        '启用或停用计划；已完成一次性计划不可重启。',
        z.object({ id, enabled: z.boolean() }).strict(),
        (r, p) => schedules.toggle(r, p.id, { enabled: p.enabled }),
      ),
      write(
        'schedule_delete',
        '删除计划；保留已完成的金额历史。',
        z.object({ id }).strict(),
        (r, p) => schedules.remove(r, p.id),
        true,
      ),
      write(
        'schedules_run',
        '以事务执行最多 20 个已到期计划，任一失败回滚本批；可按 hasMore 分批继续。',
        empty,
        (r) => schedules.run(r, true),
      ),
      read(
        'settings_get',
        '个人资料、本位币、显示菜单、备注、隐私、总览卡片、账户分组顺序及汇率状态；不返回密码或令牌。',
        empty,
        (r) => settings.settings(r, 'true'),
      ),
      write(
        'settings_update',
        '修改个人设置、本位币、分组排序、登录时长及纳入统计配置。隐私设置变更需网页确认。',
        settingsInput,
        (r, p) => settings.update(r, p, undefined as any),
      ),
      write('rates_refresh', '重试公共日汇率更新，失败保留原币和历史汇率。', empty, (r) =>
        settings.refresh(r),
      ),
      write(
        'metal_holding_create',
        '按克数创建金银资产，无需市场价格；买入每克成本可选，缺少报价时待估值。日期为 UTC+8 业务时间。',
        metalHoldingInput,
        (r, p) => metals.create(r, p),
      ),
      read('metals_prices', '最近 100 条金银每克报价和更新状态。', empty, (r) => metals.list(r)),
      write('metals_refresh', '刷新贵金属报价并沿用现有自动估值规则。', empty, (r) =>
        metals.refresh(r),
      ),
      write(
        'metal_price_set',
        '设置指定日期、币种、品种每克价格；price 十进制字符串，可能触发自动估值历史。',
        metalPriceInput,
        (r, p) => metals.manual(r, p),
      ),
      write(
        'metal_configure',
        '设置金银重量、纯度和自动估值，复用现有估值规则。',
        z.object({ id, data: metalConfig }).strict(),
        (r, p) => metals.configure(r, p.id, p.data),
      ),
      write(
        'metal_value',
        '按已有报价为指定贵金属资产生成估值历史。',
        z.object({ id }).strict(),
        (r, p) => metals.value(r, p.id),
      ),
      read(
        'icons_list',
        '搜索私有或共享图标，固定单页 60 个；使用返回 ID 配置项目图标。',
        z
          .object({
            q: z.string().max(100).default(''),
            page: z.number().int().min(1).max(100000).default(1),
          })
          .strict(),
        (r, p) => icons.list(r, p.q, String(p.page)),
      ),
      {
        name: 'backup_import',
        description:
          '提交已上传备份的追加恢复。先 file_upload_request → 上传 → import_preview；强制网页展示影响并确认，事务失败不保留部分账目。',
        schema: z.object({ token: id }).strict(),
        scope: 'sensitive',
        destructive: true,
        run: (r, p) => backup.restoreUpload(r, p.token),
      },
      read(
        'import_preview',
        '预检已上传备份并显示追加影响、冲突和条数。',
        z.object({ token: id }).strict(),
        async (r, p) => (await backup.inspectUpload(r, p.token)).preview,
      ),
      {
        name: 'credentials_change_request',
        description:
          '发起账号或密码修改，返回网页入口。当前密码及新密码仅在网页输入，不传给 Agent。完成后 operation_get 查询结果。',
        schema: empty,
        scope: 'sensitive',
        web: 'credentials',
      },
      {
        name: 'hidden_unlock_request',
        description:
          '发起隐藏项目解锁。网页用户验证密码后本连接解锁 5 分钟；operation_get 查询结果。',
        schema: empty,
        scope: 'sensitive',
        web: 'reveal',
      },
      {
        name: 'data_clear_request',
        description:
          '发起清空本账号财务数据。网页须先下载当前备份、验证密码并输入“确定清空”，展示数量；账号保留。',
        schema: empty,
        scope: 'sensitive',
        web: 'clear',
        destructive: true,
      },
    ];
  }
  get(name: string) {
    return this.tools.find((t) => t.name === name);
  }
}
