import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' }); await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const result = await page.evaluate(() => {
        const runtime = window.__reincarnationApp.runtime;
        runtime.setRegexPresets([{ enabled: true, scripts: [
            { scriptName: 'prompt', findRegex: '/SECRET/g', replaceString: 'MASKED', placement: [1], promptOnly: true, markdownOnly: false, minDepth: 1 },
            { scriptName: 'display', findRegex: '/RAW/g', replaceString: '**FORMATTED**', placement: [2], promptOnly: false, markdownOnly: true },
            { scriptName: 'both', findRegex: '/X/g', replaceString: 'Y', placement: [1, 2], promptOnly: false, markdownOnly: false },
            { scriptName: 'disabled', findRegex: '/NO/g', replaceString: 'BAD', placement: [1, 2], disabled: true },
        ] }]);
        return {
            promptDepth0: runtime.applyPromptRegex('SECRET X NO', 'user', 0),
            promptDepth1: runtime.applyPromptRegex('SECRET X NO', 'user', 1),
            displayAssistant: runtime.applyExternalDisplayRegex('RAW X NO', 'assistant', 0),
            displayUser: runtime.applyExternalDisplayRegex('RAW X', 'user', 0),
        };
    });
    console.log(JSON.stringify({ ...result, pageErrors: errors }, null, 2));
    if (result.promptDepth0 !== 'SECRET Y NO' || result.promptDepth1 !== 'MASKED Y NO' || result.displayAssistant !== '**FORMATTED** Y NO' || result.displayUser !== 'RAW Y' || errors.length) process.exitCode = 1;
} finally { await browser.close(); }
