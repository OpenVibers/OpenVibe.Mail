'use strict';
// Real local HTTP routes + migrated temporary DB; only Network/SMTP/Stalwart are isolated test services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { boot } = require('../test/helpers/boot');
const { sql } = require('openvibe-sdk/db');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright');
(async () => {
  const s = await boot({ env:{ OV_OAUTH_CLIENT_SECRET:'test-secret' },smtp:{ sendMessage:async () => ({ ok:true }) } });
  const user = s.network.addUser('inbox-proof');
  await s.post('/api/v1/masks',{ as:user,json:{ label:'Proof mailbox' } });
  const mailbox = await s.db.value(sql`SELECT address FROM mail_mailboxes WHERE owner_subject=${user.subject}`);
  await s.put('/api/v1/me/mail/workspace/signature',{ as:user,json:{ address:mailbox,signature:'Proof signature' } });
  const m = s.mail.deliver({ mailboxAddress:mailbox,to:mailbox,from:'reader@example.net',subject:'Inbox acceptance fixture',text:'This message exercises the real inbox routes.',attachments:[{ part:'1',name:'note.txt',type:'text/plain',bytes:Buffer.from('Attachment preview fixture') }] });
  m.threadId = 'conversation1';
  const browser = await chromium.launch({ executablePath:'/usr/bin/google-chrome',args:['--no-sandbox'] });
  const out = process.env.MAIL_PROOF_DIR || '/tmp/mail-inbox-proof'; fs.mkdirSync(out,{ recursive:true });
  try {
    for (const [width,scheme] of [[390,'dark'],[390,'light'],[1280,'dark'],[1280,'light']]) {
      const context = await browser.newContext({ viewport:{ width,height:900 },colorScheme:scheme,isMobile:width<700,hasTouch:width<700,deviceScaleFactor:1 });
      await context.addInitScript((scheme) => localStorage.setItem('ov_theme',JSON.stringify({ id:scheme === 'light' ? 'daylight' : 'vibe' })),scheme);
      await context.addCookies([{ name:'ov_token',value:s.network.userToken(user),url:s.base }]);
      const page = await context.newPage(), errors = [];
      page.on('pageerror',(e) => errors.push(e.message));
      // Shared network navigation is out of scope for this isolated local run.
      await page.route('https://**/*',(route) => route.abort());
      await page.goto(s.base+'/inbox');
      await page.locator('.ib-row').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth),width,'inbox overflow');
      assert.equal(await page.locator('[data-mail-addresses] .ib-ai-settings').count(),0);
      assert.equal(await page.locator('.ib-folders').evaluate((n) => n.scrollWidth<=n.clientWidth),true,'folder overflow');
      await page.screenshot({ path:`${out}/inbox-${width}-${scheme}.png`,fullPage:true });
      await page.getByRole('button',{ name:'Compose',exact:true }).click();
      await page.getByLabel('To ·').fill('recipient@openvibe.email');
      await page.getByLabel('Subject',{ exact:true }).fill('Composer proof');
      await page.getByRole('textbox',{ name:'Message',exact:true }).fill('Hello from the proof');
      await page.getByLabel('Attachments ·').setInputFiles({ name:'proof.txt',mimeType:'text/plain',buffer:Buffer.from('proof attachment') });
      await page.locator('.ib-compose-files li').waitFor();
      const dialogBox = await page.locator('.ib-compose').boundingBox(); assert.ok(dialogBox.x>=16 && dialogBox.x+dialogBox.width<=width-16,'composer outer gutter');
      assert.equal(await page.locator('.ib-compose').evaluate((n) => n.scrollWidth<=n.clientWidth),true,'composer overflow');
      await page.screenshot({ path:`${out}/compose-${width}-${scheme}.png`,fullPage:true });
      await page.getByRole('button',{ name:'Preview',exact:true }).click();
      await page.locator('.ib-preview pre').filter({ hasText:'proof attachment' }).waitFor();
      await page.getByRole('button',{ name:'Close preview' }).click();
      await page.getByRole('button',{ name:'Send · 15 seconds to undo' }).click();
      await page.getByRole('button',{ name:'Undo send',exact:true }).click();
      await page.getByRole('dialog').waitFor();
      assert.equal((await page.locator('.ib-compose').innerText()).match(/Proof signature/g).length,1,'Undo must not duplicate the signature');
      await page.getByLabel('Schedule send (optional)').fill(new Date(Date.now()+3600000).toISOString().slice(0,16));
      await page.getByRole('button',{ name:'Send · 15 seconds to undo' }).click();
      await page.getByRole('button',{ name:'Undo send',exact:true }).waitFor();
      await page.goto(s.base+'/inbox?folder=scheduled');
      await page.getByRole('button',{ name:'Cancel and edit',exact:true }).click();
      await page.getByRole('dialog').waitFor();
      page.once('dialog',(d) => d.accept());
      await page.getByRole('button',{ name:'Discard',exact:true }).click();
      await page.goto(s.base+'/inbox');
      await page.getByRole('searchbox').fill('subject:Inbox has:attachment');
      await page.getByRole('button',{ name:'Search',exact:true }).click();
      await page.locator('.ib-row').first().click();
      await page.getByRole('button',{ name:'Reply all',exact:true }).waitFor();
      await page.getByRole('button',{ name:'Reply all',exact:true }).click();
      assert.match(await page.getByLabel('To ·').inputValue(),/reader@example.net/);
      page.once('dialog',(d) => d.accept()); await page.getByRole('button',{ name:'Discard',exact:true }).click();
      await page.goto(s.base+'/inbox/settings');
      await page.getByRole('heading',{ name:/Signatures/ }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth),width,'settings overflow');
      const main = await page.locator('main[data-mail-settings]').boundingBox();
      if (width===390) { assert.equal(main.x,0); assert.equal(await page.locator('[data-mail-addresses]').evaluate((n) => Math.round(n.getBoundingClientRect().x)),16); }
      assert.ok(await page.getByRole('heading',{ name:/Rules \(/ }).isVisible());
      await page.screenshot({ path:`${out}/settings-${width}-${scheme}.png`,fullPage:true });
      assert.deepEqual(errors,[]);
      console.log(`${width} ${scheme}: inbox, composer, reply all, upload/preview, undo, schedule/cancel, search, Settings, no overflow or page errors`);
      await context.close();
    }
  } finally { await browser.close(); await s.close(); }
})().catch((err) => { console.error(err.message); process.exitCode = 1; });
