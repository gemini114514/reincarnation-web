import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.locator('[data-panel="settings"]').first().click();

    await page.locator('[data-action="new-connection"]').click();
    await page.locator('#connectionForm [name="name"]').fill('集成测试连接');
    await page.locator('#connectionForm [name="baseUrl"]').fill('http://127.0.0.1:4281');
    await page.locator('#connectionForm [name="model"]').fill('test-model');
    await page.locator('#connectionForm').evaluate(form => form.requestSubmit());
    await page.getByText('集成测试连接', { exact: true }).first().waitFor();
    await page.locator('#connectionForm [name="model"]').fill('updated-model');
    await page.locator('#connectionForm').evaluate(form => form.requestSubmit());
    await page.getByText(/updated-model/).first().waitFor();
    await page.getByText('默认 OpenAI 兼容连接', { exact: true }).first().click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-action="delete-connection"]').click();
    await page.getByText('默认 OpenAI 兼容连接', { exact: true }).waitFor({ state: 'detached' });
    await page.getByText('集成测试连接', { exact: true }).first().click();

    await page.locator('[data-settings-tab="presets"]').click();
    await page.locator('#presetFile').setInputFiles('C:\\Users\\fengx\\Downloads\\明月秋青写卡预设.json');
    await page.getByText(/91 条提示词/).waitFor({ timeout: 20000 });
    await page.locator('[data-action="activate-preset"]').click();

    await page.locator('[data-settings-tab="scripts"]').click();
    await page.locator('#scriptFile').setInputFiles('C:\\Users\\fengx\\Downloads\\酒馆助手脚本-明月秋青脚本-秋青A4.7.json');
    await page.getByText(/9\.9 MB/).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(15000);
    await page.locator('[data-action="toggle-script"]').focus();
    await page.waitForTimeout(250);
    const hiddenFocusSafe = await page.evaluate(() => document.activeElement?.dataset?.action === 'toggle-script' && document.elementFromPoint(10, innerHeight / 2)?.tagName !== 'IFRAME');
    await page.locator('[data-action="open-script-ui"]').click();
    await page.locator('.zhino-panel').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    const result = await page.evaluate(() => {
        const runtime = window.__reincarnationRuntime;
        const frame = document.querySelector('iframe[data-assistant-script]');
        return {
            preset: runtime.activePreset?.name,
            promptCount: runtime.activePreset?.prompts?.length,
            promptApplied: runtime.buildPrompt([{ role: 'user', content: '测试' }]).messages.length > 2,
            scriptFrame: Boolean(frame),
            scriptRoot: Boolean(document.querySelector('.zhino-root')),
            scriptPanel: Boolean(document.querySelector('.zhino-panel')),
            scriptText: document.querySelector('.zhino-panel')?.innerText?.slice(0, 100),
            connectionSaved: JSON.parse(localStorage.getItem('reincarnation-web:v1')).connections.some(item => item.name === '集成测试连接' && item.model === 'updated-model'),
            frameHidden: Boolean(frame?.hidden),
        };
    });
    result.hiddenFocusSafe = hiddenFocusSafe;
    console.log({ ...result, pageErrors: errors.slice(0, 20) });
    if (!result.connectionSaved || !result.hiddenFocusSafe || !result.frameHidden || result.promptCount !== 91 || !result.promptApplied || !result.scriptFrame || !result.scriptRoot || !result.scriptPanel || errors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
