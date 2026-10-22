const { chromium } = require('C:/github/ticket/node_modules/playwright');
const assert = require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('file:///C:/github/dsh-server-ops/design-preview/index.html');
 await page.screenshot({path:'C:/github/dsh-server-ops/design-preview/desktop.png',fullPage:true});
 await page.locator('#pause').click();const before=await page.locator('#output').textContent();await page.waitForTimeout(2200);assert.equal(await page.locator('#output').textContent(),before);
 await page.locator('#pause').click();await page.waitForTimeout(2200);assert.notEqual(await page.locator('#output').textContent(),before);
 await page.selectOption('#history','disk');assert.ok((await page.locator('#output').textContent()).includes('/dev/vda1'));assert.equal(await page.locator('#pause').isVisible(),false);
 await page.selectOption('#history','service');assert.match(await page.locator('#output').textContent(),/Main PID/);
 await page.selectOption('#history','live');await page.locator('summary').first().click();assert.equal(await page.locator('details').first().getAttribute('open'),null);await page.locator('summary').first().click();
 for(const width of [1440,1024,768,740,390,320]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'horizontal overflow at '+width);}
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'C:/github/dsh-server-ops/design-preview/mobile.png',fullPage:true});
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.chevron').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
 assert.deepEqual(errors,[]);console.log('PASS: pause/resume, 3 history records, collapse, widths 1440/1024/768/740/390/320, reduced motion, no script errors.');
 await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
