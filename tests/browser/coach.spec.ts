import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const writing = {
  kind: 'phrase', expression: 'retry', meaning: '重试',
  context: 'Please retry the request.', explanation: 'retry 表示重新尝试；这里是动词。',
  original: '重试', prompt: '请用英文说出“重试”。'
};
const reading = {
  kind: 'phrase', expression: 'timed out', meaning: '超时',
  context: 'The request timed out.', explanation: 'timed out 表示等待太久，未及时得到结果。',
  original: '', prompt: 'The request timed out.'
};

async function capture(request: APIRequestContext, source: 'writing' | 'reading', points: object[]) {
  const response = await request.post('/api/captures', { data: { id: randomUUID(), source, sourceLabel: '浏览器验收', points } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function showList(page: Page) {
  await expect(page.getByRole('region', { name: '学习记录列表' })).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset')).ok()).toBeTruthy();
});

test('空学习库提供真实入口，并适应窄屏', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^学习记录/ })).toBeVisible();
  await expect(page.getByText('向 Codex 提问或中英混写，学习记录会出现在这里。')).toBeVisible();
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('empty-library.png'), fullPage: true });
  await page.getByRole('button', { name: /^复习/ }).click();
  await expect(page.getByRole('heading', { name: '今天没有待复习卡片' })).toBeVisible();
});

test('记录可筛选、取消草稿、编辑、归档、恢复和导出', async ({ page, request }, testInfo) => {
  await capture(request, 'writing', [writing]);
  await capture(request, 'reading', [reading]);
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(2);
  await page.getByRole('button', { name: '写作', exact: true }).click();
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(1);
  await page.getByLabel('搜索学习记录').fill('retry');
  await page.getByRole('button', { name: '查看记录：retry', exact: true }).click();
  const detail = page.getByRole('region', { name: '词句详情' });
  await expect(detail.getByRole('heading', { name: 'retry', exact: true })).toBeVisible();
  if (testInfo.project.name === 'mobile') {
    await detail.getByRole('button', { name: '返回列表' }).click();
    await showList(page);
    await page.getByRole('button', { name: '查看记录：retry', exact: true }).click();
  }
  await detail.getByRole('button', { name: '编辑笔记' }).click();
  await detail.getByLabel('中文含义').fill('未保存的修改');
  await detail.getByRole('button', { name: '取消', exact: true }).click();
  await detail.getByRole('button', { name: '编辑笔记' }).click();
  await expect(detail.getByLabel('中文含义')).toHaveValue('重试');
  await detail.getByLabel('中文含义').fill('重新尝试');
  await detail.getByLabel('解释', { exact: true }).fill('retry the request：重新尝试这次请求。');
  await detail.getByRole('button', { name: '保存', exact: true }).click();
  await expect(detail.getByText('已保存', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '查看记录：retry', exact: true, includeHidden: true })).toContainText('重新尝试');
  await page.screenshot({ path: testInfo.outputPath('notebook.png'), fullPage: true });
  await detail.getByRole('button', { name: '归档', exact: true }).click();
  await expect.poll(async () => (await (await request.get('/api/cards?archived=true')).json()).total).toBe(1);
  await showList(page);
  await expect(page.getByRole('button', { name: '查看记录：retry', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '筛选记录' }).click();
  await page.getByRole('checkbox', { name: '已归档' }).check();
  await page.getByRole('button', { name: '查看记录：retry', exact: true }).click();
  await expect(detail.getByText('重新尝试', { exact: true })).toBeVisible();
  await expect(detail.getByText('已归档', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '恢复复习' }).click();
  await expect.poll(async () => (await (await request.get('/api/cards?archived=true')).json()).total).toBe(0);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出记录' }).click();
  expect((await downloadEvent).suggestedFilename()).toMatch(/^codex-english-coach-.*\.json$/);
  const exported = await (await request.get('/api/export')).json();
  expect(exported.cards).toHaveLength(2);
  expect(exported.cards.find((card: { expression: string }) => card.expression === 'retry').meaning).toBe('重新尝试');
});

test('分页与日期筛选正确处理最后一页归档', async ({ page, request }) => {
  await capture(request, 'writing', Array.from({ length: 13 }, (_, index) => ({ ...writing, expression: `retry step ${index}`, meaning: `重试步骤 ${index}` })));
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(12);
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(1);
  await expect(page.getByText('13–13 / 13')).toBeVisible();
  await page.getByRole('button', { name: /^查看记录：/ }).click();
  await page.getByRole('region', { name: '词句详情' }).getByRole('button', { name: '归档', exact: true }).click();
  await showList(page);
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(12);
  await expect(page.getByRole('button', { name: '下一页' })).toHaveCount(0);
  await page.getByRole('button', { name: '筛选记录' }).click();
  await page.getByLabel('开始日期').fill('2026-11-24');
  await expect(page.getByText('没有匹配的记录', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).first().click();
  await expect(page.getByRole('button', { name: /^查看记录：/ })).toHaveCount(12);
});

test('复习先隐藏答案，自评后保存两个方向的历史', async ({ page, request }, testInfo) => {
  await capture(request, 'reading', [reading]);
  await capture(request, 'writing', [writing]);
  await request.post('/__test/advance-clock', { data: { days: 2 } });
  await page.goto('/');
  await page.getByRole('button', { name: /^复习/ }).click();
  await expect(page.getByRole('button', { name: '揭晓答案' })).toBeVisible();
  await expect(page.getByTestId('review-answer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '熟悉', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '揭晓答案' }).click();
  await expect(page.getByTestId('review-answer')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('review-answer.png'), fullPage: true });
  await page.getByRole('button', { name: '熟悉', exact: true }).click();
  await expect(page.getByTestId('review-answer')).toHaveCount(0);
  await page.getByRole('button', { name: '揭晓答案' }).click();
  await page.getByRole('button', { name: '忘了', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本轮完成' })).toBeVisible();
  const exported = await (await request.get('/api/export')).json();
  expect(exported.reviews).toHaveLength(2);
  expect(new Set(exported.cards.map((card: { source: string }) => card.source))).toEqual(new Set(['reading', 'writing']));
  expect((await (await request.get('/api/reviews/queue')).json()).total).toBe(0);
});

test('评分已提交但响应丢失时，重试只保存一次', async ({ page, request }) => {
  await capture(request, 'reading', [reading]);
  await request.post('/__test/advance-clock', { data: { days: 2 } });
  const submitted: { id: string }[] = [];
  await page.route('**/api/reviews', async route => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) {
      expect((await route.fetch()).ok()).toBeTruthy();
      await route.abort();
    } else await route.continue();
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^复习/ }).click();
  await page.getByRole('button', { name: '揭晓答案' }).click();
  await page.getByRole('button', { name: '熟悉', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试提交' })).toBeVisible();
  await expect(page.getByRole('button', { name: '熟悉', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重试提交' }).click();
  await expect(page.getByRole('heading', { name: '本轮完成' })).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]!.id).toBe(submitted[0]!.id);
  const exported = await (await request.get('/api/export')).json();
  expect(exported.reviews).toHaveLength(1);
  expect(exported.cards[0].step).toBe(1);
});

test('另一页面已经评分后，可以刷新队列而非重复重试', async ({ page, request }) => {
  await capture(request, 'reading', [reading]);
  await request.post('/__test/advance-clock', { data: { days: 2 } });
  await page.goto('/');
  await page.getByRole('button', { name: /^复习/ }).click();
  await page.getByRole('button', { name: '揭晓答案' }).click();
  const queue = await (await request.get('/api/reviews/queue')).json();
  expect((await request.post('/api/reviews', { data: { id: randomUUID(), cardId: queue.items[0].id, rating: 'familiar' } })).ok()).toBeTruthy();
  await page.getByRole('button', { name: '熟悉', exact: true }).click();
  await expect(page.getByRole('button', { name: '刷新队列' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试提交' })).toHaveCount(0);
  let refreshAttempts = 0;
  await page.route('**/api/reviews/queue*', async route => {
    if (++refreshAttempts === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '队列暂不可用' }) });
    else await route.continue();
  });
  await page.getByRole('button', { name: '刷新队列' }).click();
  await expect(page.getByRole('alert')).toHaveText('队列暂不可用');
  await expect(page.getByRole('button', { name: '揭晓答案' })).toHaveCount(0);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天没有待复习卡片' })).toBeVisible();
  expect((await (await request.get('/api/export')).json()).reviews).toHaveLength(1);
});
