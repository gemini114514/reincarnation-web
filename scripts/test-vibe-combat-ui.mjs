import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), stdio: 'ignore', windowsHide: true });
const waitHealth = async () => {
    for (let index = 0; index < 50; index += 1) {
        try { const response = await fetch('http://127.0.0.1:4174/api/health'); if (response.ok) return; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('测试服务器未启动');
};

let browser;
try {
    await waitHealth();
    browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp);
    await page.locator('[data-panel="combat"]').click();
    await page.locator('[data-action="combat-new"]').click();
    const encounter = { seed: 'ui-fixed', mode: 'manual', encounter: { title: 'UI test', zones: [{ id: 'arena', name: '测试竞技场', adjacent: [], capacity: 6 }], combatants: [{ id: 'p', name: '测试主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, attack: 100, attackModifier: 100, defenseDC: 50, zoneId: 'arena' }, { id: 'e', name: '测试敌人', side: 'enemy', hp: 10, maxHp: 10, attackModifier: -100, defenseDC: 50, zoneId: 'arena' }] } };
    await page.locator('#textEditorValue').fill(JSON.stringify(encounter, null, 2));
    await page.locator('[data-editor-action="save"]').click();
    await page.getByText('测试竞技场', { exact: true }).waitFor();
    await page.locator('[data-action="combat-start"]').click();
    await page.getByText('测试主角', { exact: true }).last().waitFor();
    await page.locator('[data-combat-ability="basic-attack"][data-combat-target="e"]').click();
    await page.getByText('玩家方胜利', { exact: true }).waitFor();
    await page.locator('[data-action="combat-replay"]').click();
    const replay = JSON.parse(await page.locator('#textEditorValue').inputValue());
    assert.equal(replay.format, 'vibe-combat-replay'); assert.ok(replay.events.length > 3); assert.ok(replay.replayHash);
    await page.locator('[data-editor-action="close"]').last().click();

    // First-use script review is visible, tested, explicitly approved, then executable.
    await page.locator('[data-action="combat-new"]').click();
    const scripted = { seed: 'ui-script', mode: 'manual', encounter: { title: 'Script UI', combatants: [{ id: 'p2', name: '脚本主角', side: 'player', controller: 'player', hp: 100, maxHp: 100, attackModifier: 100, abilities: [{ id: 'arc', name: '电弧', type: 'true', range: 'contact', script: `api.damage(input.targets[0].id, 200, "true"); // UI review ${Date.now()}` }] }, { id: 'e2', name: '脚本靶', side: 'enemy', hp: 20, maxHp: 20, attackModifier: -100 }] } };
    await page.locator('#textEditorValue').fill(JSON.stringify(scripted, null, 2)); await page.locator('[data-editor-action="save"]').click();
    await page.locator('[data-action="combat-start"]').click(); await page.getByText('运行 100 组固定种子审查', { exact: true }).waitFor();
    await page.locator('[data-action="combat-inspect-script"]').click();
    await page.waitForFunction(() => document.querySelector('#textEditorValue')?.value.includes('固定种子测试'));
    const reviewText = await page.locator('#textEditorValue').inputValue(); assert.ok(reviewText.includes('100 / 100 通过'));
    await page.locator('[data-editor-action="close"]').last().click(); await page.locator('[data-action="combat-approve-script"]').click();
    await page.locator('[data-action="combat-start"]').click(); await page.locator('[data-combat-ability="arc"][data-combat-target="e2"]').click();
    await page.getByText('玩家方胜利', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, battleId: replay.battleId, events: replay.events.length, replayHash: replay.replayHash, pageErrors: errors }, null, 2));
} finally {
    await browser?.close();
    server.kill();
}
