'use strict';
/* 无头 Chrome + CDP 验证脚本：不依赖第三方库 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = 'C:\\Users\\pamphile\\Documents\\Trae-CN\\temp_20261104_01';
const SHOTS = path.join(ROOT, 'screenshots');
const FILE_URL = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(ROOT, '.chrome-profile-' + Date.now());
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitPort(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await getJSON(`http://127.0.0.1:${PORT}/json/version`);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) {}
    await sleep(200);
  }
  throw new Error('Chrome 调试端口未就绪');
}

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.logs = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', (e) => reject(new Error('websocket error')));
      this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    });
  }
  onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      this.errors.push('exception: ' + ((d.exception && d.exception.description) || d.text));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      this.errors.push('log.error: ' + msg.params.entry.text);
    }
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async ev(expression, userGesture) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: !!userGesture
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('JS异常: ' + ((d.exception && d.exception.description) || d.text) + '\n表达式: ' + expression.slice(0, 160));
    }
    return r.result ? r.result.value : undefined;
  }
  async waitFor(expression, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 8000)) {
      try { if (await this.ev(expression)) return true; } catch (e) {}
      await sleep(100);
    }
    return false;
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
    return path.join(SHOTS, name);
  }
}

const results = { steps: [], checks: [], shots: [] };
function check(name, pass, detail) {
  results.checks.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1600,900', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let cdp = null;
  try {
    const info = await waitPort();
    const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
    const page = list.find((t) => t.type === 'page');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await cdp.send('Page.navigate', { url: FILE_URL });
    if (!(await cdp.waitFor('window.__appReady === true', 10000))) throw new Error('页面未就绪');

    const dims = await cdp.ev(`(() => {
      const d = document.documentElement;
      return { iw: innerWidth, ih: innerHeight, sw: d.scrollWidth, sh: d.scrollHeight,
               bw: document.body.scrollWidth, bh: document.body.scrollHeight };
    })()`);
    check('视口 1600x900', dims.iw === 1600 && dims.ih === 900, JSON.stringify(dims));
    check('页面无溢出', dims.sw <= 1600 && dims.sh <= 900, `scroll ${dims.sw}x${dims.sh}`);

    const leftFit = await cdp.ev(`(() => {
      const qr = document.querySelector('.quick-recharge').getBoundingClientRect();
      const panel = document.querySelector('.pity-panel').getBoundingClientRect();
      const sc = document.querySelector('.pity-scroll');
      const scr = sc.getBoundingClientRect();
      return { qrBottom: Math.round(qr.bottom), panelBottom: Math.round(panel.bottom), panelTop: Math.round(panel.top),
               qrTop: Math.round(qr.top), scrollTop: Math.round(scr.top), qrH: Math.round(qr.height),
               scrollCh: sc.clientHeight, scrollSh: sc.scrollHeight };
    })()`);
    check('左栏保底与充值区完整可见', leftFit.qrBottom <= leftFit.panelBottom + 1 && leftFit.qrH > 60 && leftFit.scrollCh >= leftFit.scrollSh, JSON.stringify(leftFit));

    const s0 = await cdp.ev('window.__sim.state()');
    const ls0 = await cdp.ev('localStorage.getItem("stellar_crate_sim_v1")');
    check('初始余额', s0.balance === 3600, 'balance=' + s0.balance + ' localStorage=' + (ls0 ? '有残留' : '空'));

    results.shots.push(await cdp.shot('01-home.png'));
    results.steps.push('01 首页截图');

    // 充值弹层
    await cdp.ev('document.getElementById("btnRecharge").click()', true);
    await sleep(260);
    results.shots.push(await cdp.shot('06-recharge.png'));
    const modalText = await cdp.ev('document.querySelector(".modal .warn").textContent');
    check('充值弹层含虚拟声明', /不产生任何真实交易|不跳转任何支付页面/.test(modalText), modalText.slice(0, 40));
    await cdp.ev('document.getElementById("modalClose").click()', true);
    await sleep(200);

    // 切换箱子 + 十连演出
    await cdp.ev('document.querySelector(\'[data-crate="c3"]\').click()', true);
    await cdp.ev('window.__sim.addCoins(20000)');
    await sleep(150);
    await cdp.ev('document.getElementById("btnOpen10").click()', true);
    await sleep(1050);
    results.shots.push(await cdp.shot('02-anim.png'));
    results.steps.push('02 十连演出中截图');
    await cdp.waitFor('document.getElementById("stageResult").hidden === false', 6000);
    await sleep(1800);
    const cardCount = await cdp.ev('document.querySelectorAll("#resultGrid .card").length');
    const flipped = await cdp.ev('document.querySelectorAll("#resultGrid .card.flipped").length');
    check('十连展示 10 张卡且全部翻开', cardCount === 10 && flipped === 10, cardCount + '/' + flipped);
    const gridBox = await cdp.ev(`(() => {
      const g = document.getElementById('resultGrid');
      const s = document.getElementById('stage');
      return { gridH: g.scrollHeight, stageH: s.clientHeight, gridW: g.scrollWidth, stageW: s.clientWidth };
    })()`);
    check('十连结果区未溢出舞台', gridBox.gridH <= gridBox.stageH && gridBox.gridW <= gridBox.stageW, JSON.stringify(gridBox));
    results.shots.push(await cdp.shot('03-ten.png'));
    results.steps.push('03 十连结果截图');

    // 重置存档（不再抽样）
    await cdp.ev('document.getElementById("btnReset").click()', true);
    await sleep(120);
    await cdp.ev('document.getElementById("btnReset").click()', true);
    await sleep(300);
    const sReset = await cdp.ev('window.__sim.state()');
    check('重置后清空统计与背包', sReset.stats.opens === 0 && Object.keys(sReset.inventory).length === 0 && sReset.balance === 3600,
      'opens=' + sReset.stats.opens + ' balance=' + sReset.balance);
    await sleep(2600);

    // 1000 次单开（走真实应用路径：扣币 / 背包 / 历史 / 统计 / 保底）
    await cdp.ev('window.__sim.addCoins(800000)');
    const run = await cdp.ev('window.__sim.open("c3", 1000, 1)');
    check('1000 次单开执行成功', run && run.ok && run.opens === 1000, JSON.stringify(run));

    const st = await cdp.ev('window.__sim.state()');
    const invSum = Object.values(st.inventory).reduce((a, b) => a + b, 0);
    const raritySum = Object.values(st.stats.byRarity).reduce((a, b) => a + b, 0);
    check('余额扣减正确', st.balance === 803600 - 800000, 'balance=' + st.balance);
    check('背包数量与开箱数一致', invSum === 1000, 'inventory=' + invSum);
    check('稀有度统计与开箱数一致', raritySum === 1000 && st.stats.opens === 1000, 'sum=' + raritySum + ' opens=' + st.stats.opens);
    check('按箱体记录正确', st.stats.byCrate.c3.opens === 1000, 'c3=' + st.stats.byCrate.c3.opens);

    // 统计 / 概率公示截图
    await cdp.ev('document.querySelector(\'[data-tab="stats"]\').click()', true);
    await sleep(200);
    await cdp.ev('document.getElementById("toast").classList.remove("show")');
    await sleep(300);
    results.shots.push(await cdp.shot('05-stats.png'));
    const statsOverflow = await cdp.ev(`(() => {
      const d = document.documentElement;
      return { sw: d.scrollWidth, sh: d.scrollHeight };
    })()`);
    check('统计页无溢出', statsOverflow.sw <= 1600 && statsOverflow.sh <= 900, JSON.stringify(statsOverflow));

    await cdp.ev('document.querySelector(\'[data-tab="rates"]\').click()', true);
    await sleep(120);
    await cdp.ev('document.querySelector(\'[data-rate="c3"]\').click()', true);
    await sleep(120);
    await cdp.ev('(() => { const d = document.querySelector("#ratesBody details"); if (d) d.open = true; })()');
    await sleep(200);
    await cdp.ev('document.getElementById("toast").classList.remove("show")');
    await sleep(300);
    results.shots.push(await cdp.shot('04-rates.png'));
    const weights = await cdp.ev('document.querySelectorAll("#ratesBody .rate-item").length');
    check('概率公示可展开物品权重', weights === 15, 'items=' + weights);
    const ratesFit = await cdp.ev(`(() => {
      const p = document.getElementById('pane-rates');
      return { ch: p.clientHeight, sh: p.scrollHeight };
    })()`);
    check('概率公示展开后完整可见', ratesFit.ch >= ratesFit.sh, JSON.stringify(ratesFit));

    await cdp.ev('document.querySelector(\'[data-tab="bag"]\').click()', true);
    await sleep(260);
    results.shots.push(await cdp.shot('07-bag.png'));

    // 刷新持久化
    const before = await cdp.ev('window.__sim.state()');
    await cdp.send('Page.reload');
    const ok = await cdp.waitFor('window.__appReady === true', 10000);
    await sleep(400);
    const after = ok ? await cdp.ev('window.__sim.state()') : null;
    check('刷新后 localStorage 存档保留',
      !!after && after.balance === before.balance && after.stats.opens === before.stats.opens &&
      Object.values(after.inventory).reduce((a, b) => a + b, 0) === 1000,
      after ? 'balance=' + after.balance + ' opens=' + after.stats.opens : 'reload failed');

    // 十连保底：统计 1000 抽 = 100 个十连，每批必有稀有+
    const ten = await cdp.ev('window.__sim.simulate("c1", 1000, { batch: 10, pity: true })');
    let batchesWithoutRare = 0;
    for (let i = 0; i < ten.seq.length; i += 10) {
      const batch = ten.seq.slice(i, i + 10);
      if (!batch.some((r) => ['rare', 'epic', 'legend'].includes(r))) batchesWithoutRare++;
    }
    check('十连必出稀有及以上（100 批）', batchesWithoutRare === 0,
      '无稀有批次数=' + batchesWithoutRare + ' 十连保底触发=' + ten.triggers.tenRare);

    // 自然概率（关闭保底）：验证权重表本身
    const natural = await cdp.ev('window.__sim.simulate("c1", 5000, { pity: false })');
    const c2pity = await cdp.ev('window.__sim.simulate("c2", 1000, { pity: true })');
    const baseRate = { common: 0.52, fine: 0.30, rare: 0.13, epic: 0.03, legend: 0.02 };
    let maxRelErr = 0;
    Object.keys(baseRate).forEach((r) => {
      const act = natural.counts[r] / 5000;
      maxRelErr = Math.max(maxRelErr, Math.abs(act - baseRate[r]) / baseRate[r]);
    });
    check('关闭保底时权重表与公示基础概率一致（5000 抽）', maxRelErr < 0.25,
      'counts=' + JSON.stringify(natural.counts) + ' 最大相对偏差=' + (maxRelErr * 100).toFixed(1) + '%');

    // 90 抽传说保底：售后置 89，下一抽必须传说
    await cdp.ev('window.__sim.setPity(88)');
    const p88 = await cdp.ev('window.__sim.open("c1", 1, 1)');
    check('第 89 抽不强制传说', p88.triggers.legend === 0, 'triggers=' + p88.triggers.legend);
    await cdp.ev('window.__sim.setPity(89)');
    const before90 = await cdp.ev('window.__sim.state()');
    const p90 = await cdp.ev('window.__sim.open("c1", 1, 1)');
    const after90 = await cdp.ev('window.__sim.state()');
    const legendDiff = after90.stats.byRarity.legend - before90.stats.byRarity.legend;
    check('第 90 抽必出传说并清零计数',
      p90.triggers.legend === 1 && legendDiff === 1 && after90.pityLegend === 0,
      'triggers=' + p90.triggers.legend + ' legend+=' + legendDiff + ' pity=' + after90.pityLegend);

    // 传说独立演出截图（置保底 89 后走 UI 单开，必出传说）
    await cdp.ev('window.__sim.setPity(89)');
    await cdp.ev('document.getElementById("btnOpen1").click()', true);
    await sleep(1350);
    const bannerShown = await cdp.ev('document.getElementById("legendBanner").classList.contains("show")');
    check('传说演出横幅出现', bannerShown === true, 'banner=' + bannerShown);
    results.shots.push(await cdp.shot('08-legend.png'));
    await sleep(1600);

    const sFinal = await cdp.ev('window.__sim.state()');
    results.data = {
      initial: { balance: 3600 },
      after1000: {
        balance: st.balance, opens: st.stats.opens, spent: st.stats.spent,
        byRarity: st.stats.byRarity, triggers: st.stats.triggers, pityLegend: st.pityLegend,
        inventoryKinds: Object.keys(st.inventory).length, inventoryTotal: invSum
      },
      natural5000: natural.counts,
      c2Pity1000: c2pity.counts,
      tenBatch: { batches: ten.seq.length / 10, withoutRare: batchesWithoutRare, triggers: ten.triggers },
      final: sFinal.stats.byRarity
    };
    results.shots.forEach((p, i) => results.steps.push('截图 ' + (i + 1) + ': ' + p));
    results.consoleErrors = cdp.errors.slice();
    check('控制台零报错', cdp.errors.length === 0, cdp.errors.join(' | ') || '无');

    fs.writeFileSync(path.join(ROOT, 'verify', 'report-data.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log('\n==== 汇总 ====');
    console.log(JSON.stringify(results.data, null, 2));
    console.log('截图:', results.shots.join('\n      '));
    const failed = results.checks.filter((c) => !c.pass);
    console.log('\n检查项: ' + results.checks.length + ' 通过 ' + (results.checks.length - failed.length) + ' 失败 ' + failed.length);
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('ERROR:', e && e.stack || e);
    if (cdp) console.error('consoleErrors:', cdp.errors);
    process.exitCode = 1;
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    await sleep(300);
  }
})();
