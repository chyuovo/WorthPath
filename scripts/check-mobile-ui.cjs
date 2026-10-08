const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
// Reusable UI regression with synthetic API data; never connects to a live ledger.
// Start Vite first. Set WORTHPATH_PLAYWRIGHT_MODULE if Playwright is not resolvable.
const { chromium } = require(process.env.WORTHPATH_PLAYWRIGHT_MODULE || 'playwright');
const baseUrl = process.env.WORTHPATH_UI_URL || 'http://127.0.0.1:5175';
const output =
  process.env.WORTHPATH_UI_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'worthpath-ui-'));
fs.mkdirSync(output, { recursive: true });
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date());
const user = {
  username: 'UI预览',
  role: 'admin',
  baseCurrency: 'CNY',
  hiddenMenus: [],
  showNotes: true,
  idleMinutes: 0,
  revealed: false,
  requireHiddenPassword: false,
};
let failNext = false;
let accounts = ['日常账户', '储蓄账户', '信用卡'].map((name, index) => ({
  id: `fixture-${index}`,
  name,
  kind: 'account',
  side: index === 2 ? 'liability' : 'asset',
  category: index === 2 ? 'credit_card' : 'bank',
  currency: 'CNY',
  amount: String((index + 1) * 100),
  groupName: index === 2 ? '信用账户' : '日常',
  hidden: false,
  archived: false,
  included: true,
  outgoing: [],
  notes: '',
  converted: '100',
  activityDate: index === 0 ? day : null,
}));
(async () => {
  const browser = await chromium.launch({
    headless: true,
    channel: process.env.WORTHPATH_BROWSER_CHANNEL || 'msedge',
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const endpoint = url.pathname.replace('/api', '');
      if (failNext && endpoint === '/positions') {
        failNext = false;
        await route.fulfill({ status: 400, json: { error: '浏览器验收错误' } });
        return;
      }
      let body = {};
      if (endpoint === '/auth/me') body = user;
      else if (endpoint === '/settings') body = { ...user, rates: [], fxStatus: null };
      else if (endpoint === '/overview')
        body = {
          date: day,
          assets: '600',
          liabilities: '300',
          net: '300',
          complete: true,
          missing: [],
          items: [],
          baseCurrency: 'CNY',
          revealed: false,
        };
      else if (endpoint === '/positions')
        body = url.searchParams.get('kind') === 'account' ? accounts : [];
      else if (endpoint === '/schedules/run') body = { executed: 0, errors: [], hasMore: false };
      else if (endpoint === '/schedules') body = [];
      else if (endpoint === '/admin/users') body = { items: [], total: 0 };
      else if (endpoint === '/calendar')
        body = {
          items: Array.from({ length: 31 }, (_, i) => ({
            date: day.slice(0, 7) + '-' + String(i + 1).padStart(2, '0'),
            income: i === 2 ? '160501.27' : '0',
            expense: i === 2 ? '897.82' : '0',
            complete: true,
          })),
          baseCurrency: 'CNY',
        };
      else if (['/trend', '/history', '/transfers', '/calendar/day'].includes(endpoint))
        body = { items: [], nextCursor: null, revealed: false };
      await route.fulfill({ json: body });
    });
    await page.goto(baseUrl);
    await page.locator('.primary-nav').waitFor();
    const nav = page.locator('.primary-nav');
    assert.deepEqual(await nav.locator('button').allTextContents(), [
      '总览',
      '日历',
      '账号',
      '设置',
    ]);
    const checkWidth = async (label) => {
      await page
        .locator('[role="status"]')
        .filter({ hasText: '正在刷新数据' })
        .waitFor({ state: 'hidden' });
      const widths = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      assert.ok(
        widths.page <= widths.viewport,
        `${label} horizontal overflow: ${JSON.stringify(widths)}`,
      );
    };
    await checkWidth('overview');
    const touch = await page.context().newCDPSession(page);
    const tabCenters = await nav.locator('button').evaluateAll((bs) =>
      bs.map((b) => {
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    const swipe = async (from, to) => {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...from, id: 1 }],
      });
      for (let i = 1; i <= 8; i++)
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: from.x + ((to.x - from.x) * i) / 8, y: from.y, id: 1 }],
        });
      assert.equal(await nav.getAttribute('data-dragging'), 'true');
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(tabCenters[0], tabCenters[1]);
    await page.waitForFunction(
      () =>
        document.querySelector('.primary-nav [aria-current="page"]')?.getAttribute('data-key') ===
        'calendar',
    );
    await swipe(tabCenters[1], tabCenters[0]);
    await page.waitForFunction(
      () =>
        document.querySelector('.primary-nav [aria-current="page"]')?.getAttribute('data-key') ===
        'overview',
    );
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...tabCenters[0], id: 1 }],
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...tabCenters[2], id: 1 }],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert.equal(await nav.locator('[aria-current="page"]').getAttribute('data-key'), 'overview');
    assert.equal(await nav.getAttribute('data-dragging'), null);
    console.log(
      'PASS: real touch swipe both directions, direct selection tracking and cancellation.',
    );
    await nav.getByRole('button', { name: '账号', exact: true }).click();
    await page.getByRole('heading', { name: '日常账户', exact: true }).waitFor();
    await checkWidth('accounts');
    await page.setViewportSize({ width: 1440, height: 900 });
    const toolbar = await page.locator('.account-tools-browse').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        height: r.height,
        widths: [...el.children]
          .filter((x) => !x.hidden)
          .map((x) => x.getBoundingClientRect().width),
      };
    });
    assert.ok(toolbar.height < 100, 'browse controls should share one row on desktop');
    await page.screenshot({
      path: path.join(output, 'worthpath-desktop-toolbar.png'),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, 'worthpath-mobile-accounts.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '快速记账', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: '标记当天已记账', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: '隐藏当天有记录', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: '日常账户', exact: true }).count(), 0);
    await page.getByRole('button', { name: '显示当天有记录', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: '日常账户', exact: true }).count(), 1);
    for (const width of [320, 375, 390, 430, 768, 1440]) {
      await page.setViewportSize({ width, height: 844 });
      await checkWidth(`quick ${width}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, 'worthpath-mobile-quick.png'),
      fullPage: true,
    });
    await page
      .locator('.section-nav')
      .getByRole('button', { name: '独立资产', exact: true })
      .click();
    assert.equal(await nav.locator('[aria-current="page"]').textContent(), '账号');
    await page.locator('.section-nav').getByRole('button', { name: '债务', exact: true }).click();
    await checkWidth('debt');
    await nav.getByRole('button', { name: '设置', exact: true }).click();
    await page.locator('.settings-category select').selectOption('privacy');
    await checkWidth('settings');
    await page.screenshot({
      path: path.join(output, 'worthpath-mobile-settings.png'),
      fullPage: true,
    });
    await page
      .locator('.section-nav')
      .getByRole('button', { name: '定时计划', exact: true })
      .click();
    await checkWidth('plans');
    assert.equal(await nav.locator('[aria-current="page"]').textContent(), '设置');
    await page
      .locator('.section-nav')
      .getByRole('button', { name: '管理员后台', exact: true })
      .click();
    await checkWidth('admin');
    await nav.getByRole('button', { name: '日历', exact: true }).click();
    await page.locator('.calendar-day').first().waitFor();
    await checkWidth('calendar');
    const activeDay = page
      .locator('.calendar-day')
      .filter({ has: page.locator('.income-dot') })
      .first();
    await activeDay.click();
    assert.ok((await page.locator('.calendar-totals').textContent()).includes('160,501.27'));
    assert.equal(await activeDay.locator('.calendar-amount').first().isVisible(), false);
    assert.equal(await activeDay.locator('.calendar-mobile-price').first().isVisible(), true);
    assert.ok(
      (await activeDay.locator('.calendar-mobile-price').first().textContent()).includes('16.1'),
    );
    assert.equal(
      await page
        .locator('.sidebar')
        .evaluate((el) => getComputedStyle(el).backdropFilter.includes('blur')),
      true,
    );
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 844 });
        await checkWidth('calendar ' + scheme + ' ' + width);
        assert.ok(
          await page
            .locator('.calendar-grid')
            .evaluate((el) => el.getBoundingClientRect().height < 500),
        );
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        await checkWidth('calendar large text');
        await page.evaluate(() => (document.documentElement.style.fontSize = ''));
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(output, 'worthpath-mobile-calendar.png'),
      fullPage: true,
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(
      await nav
        .locator('button')
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      '0s',
    );

    await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
    await nav.getByRole('button', { name: '账号', exact: true }).click();
    await page.getByRole('button', { name: '退出快速记账', exact: true }).click();
    await page.getByRole('button', { name: '快速记账', exact: true }).click();
    await page.locator('.position-card').first().click();
    const modal = page.locator('dialog.native-modal[open]');
    await modal.waitFor();
    assert.equal(await modal.evaluate((el) => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await modal.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.input), 'keyboard');
    assert.equal(
      await nav
        .locator('button')
        .first()
        .evaluate((el) => getComputedStyle(el).transitionDuration),
      '0s',
    );
    const demo = accounts;
    const worst = accounts.map((account, i) => ({
      ...account,
      name: [
        '家庭长期退休储备与跨境投资专用账户（用于记录定期存款、货币基金、证券组合及年度家庭应急备用金，请勿与日常消费账户混用）'
          .repeat(2)
          .slice(0, 100),
        'Christopher Alexander Montgomery III · Hong Kong investment reserve',
        'J',
      ][i],
      groupName: ['跨境投资与长期退休储备账户（不参与日常消费流水）', '消费', '信用'][i],
      amount: ['9999999999999999.98765432', '-42.5', '0'][i],
      notes:
        i === 0
          ? 'https://example.com/workspaces/household/accounts/international-reserve?tab=transactions&filter=long-term'
          : '',
    }));
    const fixtures = {
      Demo: demo,
      'Worst case': worst,
      Empty: [],
      One: [worst[0]],
      '1,000 rows': Array.from({ length: 1000 }, (_, i) => ({
        ...demo[i % 3],
        id: 'bulk-' + i,
        name: '家庭账户 ' + (i + 1),
      })),
    };
    // Dev-only fixture picker: injected into this isolated browser session, never production.
    await page.exposeFunction('chooseFixture', async (name) => {
      accounts = fixtures[name];
    });
    await page.addInitScript(() =>
      document.addEventListener('DOMContentLoaded', () => {
        const panel = document.createElement('div');
        panel.id = 'fixture-picker';
        panel.style.cssText =
          'position:fixed;bottom:100px;left:50%;transform:translateX(-50%);z-index:9999;background:#ddd;padding:4px;border-radius:8px;display:flex;gap:3px;font:11px system-ui;max-width:95%;';
        for (const name of ['Demo', 'Worst case', 'Empty', 'One', '1,000 rows']) {
          const button = document.createElement('button');
          button.textContent = name;
          button.style.cssText =
            'font:inherit;border:0;border-radius:5px;padding:6px;background:white;color:#1d1d1f;';
          button.onclick = async () => {
            await window.chooseFixture(name);
            const url = new URL(location.href);
            url.searchParams.set('data', name);
            location.href = url;
          };
          panel.append(button);
        }
        document.body.append(panel);
      }),
    );
    for (const [name, values] of Object.entries(fixtures)) {
      accounts = values;
      await page.evaluate(() => localStorage.setItem('worthpath.locale', 'zh-Hans'));
      await page.goto(baseUrl + '/?data=' + encodeURIComponent(name));
      await page.locator('.primary-nav').waitFor();
      await page.locator('.primary-nav').getByRole('button', { name: '账号', exact: true }).click();
      await page.getByRole('button', { name: '快速记账', exact: true }).click();
      await page
        .locator('[role="status"]')
        .filter({ hasText: '正在刷新数据' })
        .waitFor({ state: 'hidden' });
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await checkWidth(name + ' ' + width);
      }
      assert.equal(await page.locator('.position-card').count(), values.length);
      if (name === 'Worst case') {
        for (const scheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: scheme });
          for (const locale of ['zh-Hans', 'zh-Hant', 'en']) {
            await page.locator('.language-picker select').selectOption(locale);
            await page.setViewportSize({ width: 320, height: 844 });
            await checkWidth(scheme + ' ' + locale);
            await page.evaluate(() => {
              document.documentElement.style.fontSize = '200%';
            });
            await checkWidth('200% ' + scheme + ' ' + locale);
            await page.evaluate(() => {
              document.documentElement.style.fontSize = '';
            });
          }
        }
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#fixture-picker').evaluate((el) => {
          el.style.visibility = 'hidden';
        });
        await page.screenshot({
          path: path.join(output, 'worthpath-mobile-worst-dark.png'),
          fullPage: true,
        });
        await page.locator('#fixture-picker').evaluate((el) => {
          el.style.visibility = '';
        });
      }
    }
    console.log(
      'PASS: native dialog focus/Escape, keyboard no motion; plausible schema-limit names and amounts, empty/one/1,000 records, light/dark, three locales, 200% text.',
    );

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    });
    assert.equal(
      await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).backdropFilter),
      'none',
    );
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-contrast', value: 'more' }],
    });
    assert.equal(
      await page.locator('.topbar').evaluate((el) => getComputedStyle(el).backdropFilter),
      'none',
    );
    assert.equal(
      await page.locator('html').evaluate((el) => getComputedStyle(el).scrollbarWidth),
      'auto',
    );
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    assert.equal(
      await page.locator('html').evaluate((el) => getComputedStyle(el).scrollbarWidth),
      'thin',
    );
    failNext = true;
    await page.locator('.topbar [aria-label="刷新数据"]').click();
    const toast = page.locator('.toast').last();
    await toast.waitFor();
    assert.equal(await toast.evaluate((el) => getComputedStyle(el).animationName), 'none');
    await toast.getByRole('button').click();
    await toast.waitFor({ state: 'hidden' });
    console.log(
      'PASS: reduced transparency, higher contrast and interruptible toast entry/dismissal.',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: four entries, child navigation, daily activity filtering, six viewport widths, calendar/settings/admin and reduced motion; zero browser errors. Screenshots use synthetic data.',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
