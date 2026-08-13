import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.getByText('世界总览', { exact: true }).last().waitFor();
    await page.getByText('玩法运行时就绪').waitFor();

    await page.getByRole('button', { name: /继续冒险/ }).click();
    await page.getByText('REINCARNATION PROTOCOL · 3.2.6').waitFor();
    await page.locator('[data-cover-agree]').check();
    await page.getByRole('button', { name: '接入主神终端' }).click();
    await page.getByRole('button', { name: '开始建档' }).click();
    await page.locator('#setupForm [name="name"]').fill('测试轮回者');
    await page.locator('[data-attribute="力量"][data-delta="1"]').click();
    await page.locator('[data-attribute="敏捷"][data-delta="1"]').click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '注入 MVU 并开始' }).click();
    await page.getByPlaceholder('你准备做什么？').waitFor();

    await page.evaluate(() => {
        const app = window.__reincarnationApp;
        app.store.addMessage('assistant', '第二层剧情测试');
        app.store.activeSession.variables.stat_data.关系列表 = {
            甲: { 好感度: 12, 好感度关系: { 乙: -3 } },
            乙: { 好感度关系: {} },
        };
        app.store.save(); app.renderAll();
    });
    await page.locator('[data-panel="chat"]').first().click();
    await page.getByText('建立轮回者档案', { exact: true }).waitFor();
    await page.locator('[data-action="floor-next"]').click();
    await page.locator('#messages').getByText('第二层剧情测试', { exact: true }).waitFor();
    await page.locator('[data-action="floor-prev"]').click();
    await page.getByText('建立轮回者档案', { exact: true }).waitFor();
    await page.locator('[data-action="floor-next"]').click();

    await page.getByRole('button', { name: /主角档案/ }).click();
    await page.locator('#statusContent').getByText('HP', { exact: true }).waitFor();
    await page.getByRole('button', { name: /装备与道具/ }).click();
    await page.getByText('装备与道具', { exact: true }).last().waitFor();
    await page.getByRole('button', { name: /世界档案/ }).click();
    await page.getByText('世界档案', { exact: true }).last().waitFor();
    await page.getByRole('button', { name: /实体关系/ }).click();
    await page.getByText('互相好感度', { exact: true }).waitFor();
    for (const panel of ['hub', 'chat', 'missions', 'status', 'inventory', 'abilities', 'world', 'relations', 'intel', 'archive', 'settings']) {
        await page.locator(`[data-panel="${panel}"]`).first().click();
        await page.locator(`#view-${panel}`).waitFor({ state: 'visible' });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-action="toggle-rail"]').click();
    await page.locator('#rail.open').waitFor();
    await page.locator('[data-panel="hub"]').first().click();
    await page.locator('#view-hub').waitFor({ state: 'visible' });

    const result = await page.evaluate(() => {
        const data = JSON.parse(localStorage.getItem('reincarnation-web:v1'));
        const session = data.sessions.find(item => item.id === data.activeSessionId);
        return {
            player: data.settings.userName,
            strength: session.variables.stat_data['主角']['最终属性']['力量'],
            world: session.variables.stat_data['世界']['名称'],
            hasIframe: Boolean(document.querySelector('iframe')),
            views: document.querySelectorAll('.view').length,
            promptReady: document.querySelector('#messageInput').value.includes('轮回者建档完成'),
            floors: document.querySelector('#tokenBadge').textContent,
            navCategories: document.querySelectorAll('.nav-category').length,
            affectionNpcToPlayer: window.__reincarnationApp.getAffection('甲', '主角'),
            affectionNpcToNpc: window.__reincarnationApp.getAffection('甲', '乙'),
            affectionMissing: window.__reincarnationApp.getAffection('乙', '甲'),
        };
    });
    console.log({ ...result, pageErrors: errors });
    if (result.player !== '测试轮回者' || result.strength < 1 || result.world !== '主神空间' || result.hasIframe || result.views < 10 || !result.promptReady || !result.floors.includes('/ 2 楼') || result.navCategories !== 2 || result.affectionNpcToPlayer !== 12 || result.affectionNpcToNpc !== -3 || result.affectionMissing !== 0 || errors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
