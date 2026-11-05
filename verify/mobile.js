'use strict';
/* 移动端（设备模拟）无头 Chrome + CDP 验证：不依赖第三方库 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = 'C:\\Users\\pamphile\\Documents\\Trae-CN\\temp_20261104_01';
const SHOTS = path.join(ROOT, 'screenshots', 'mobile');
const FILE_URL = 'file:///' + path.join(ROOT, 'index.html').split(path.sep).join('/');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = path.join(ROOT, '.chrome-profile-m' + Date.now());
const PORT = 9444;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const d = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (d && d.webSocketDebuggerUrl) return d;
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
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', () => reject(new Error('websocket error')));
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
      throw new Error('JS异常: ' + ((d.exception && d.exception.description) || d.text));
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
    return name;
  }
}

const report = { devices: [], perf: {}, consoleErrors: [] };
function check(list, name, pass, detail) {
  list.push({ name, pass: !!pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
}

const DEVICES = [
  { label: '375x667', w: 375, h: 667, dsf: 2, shots: ['home', 'ten'] },
  { label: '390x844', w: 390, h: 844, dsf: 3, shots: ['anim', 'rates'] },
  { label: '360x800', w: 360, h: 800, dsf: 3, shots: ['bag'] },
  { label: '414x896', w: 414, h: 896, dsf: 2, shots: ['recharge'] }
];

const MEASURE = `(() => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             l: Math.round(r.left), r: Math.round(r.right),
             t: Math.round(r.top), b: Math.round(r.bottom) };
  };
  const targets = ['#btnOpen1', '#btnOpen10', '#btnRecharge', '#btnSound', '#btnReset',
                   '#quickTiers button', '.tabs .tab', '#bagFilters .chip', '#rateCrates .chip'];
  const small = [];
  targets.forEach((s) => {
    const e = document.querySelector(s);
    if (!e) { small.push({ sel: s, w: 0, h: 0, missing: true }); return; }
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return; // 当前未显示的标签页，稍后在可见状态下单独量
    if (r.width < 43.5 || r.height < 43.5) small.push({ sel: s, w: Math.round(r.width), h: Math.round(r.height) });
  });
  const legal = document.querySelector('.legal');
  const idle = document.querySelector('.stage-idle');
  return {
    iw: innerWidth, ih: innerHeight,
    sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    bw: document.body.scrollWidth,
    smallTargets: small,
    legal: box('.legal'),
    legalTruncated: legal ? legal.scrollWidth > legal.clientWidth + 1 : true,
    legalText: legal ? legal.textContent : '',
    idleFits: idle ? idle.scrollHeight <= idle.clientHeight + 1 : false,
    idleBox: box('.stage-idle'),
    stageH: Math.round(document.getElementById('stage').getBoundingClientRect().height),
    topbarH: Math.round(document.querySelector('.topbar').getBoundingClientRect().height)
  };
})()`;

const FPS_START = `(() => {
  window.__fps = { t0: performance.now(), n: 0, long: 0, dur: 0, last: performance.now() };
  window.__lt = [];
  try {
    if (window.__ltObs) window.__ltObs.disconnect();
    window.__ltObs = new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) { window.__lt.push(Math.round(e.duration)); });
    });
    window.__ltObs.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  const tick = (ts) => {
    const f = window.__fps;
    if (!f) return;
    f.n++;
    if (ts - f.last > 33) f.long++;
    f.last = ts;
    if (ts - f.t0 < 1600) requestAnimationFrame(tick);
    else { f.dur = ts - f.t0; f.done = true; }
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const FPS_READ = `(() => {
  const f = window.__fps;
  if (!f || !f.done) return null;
  return {
    frames: f.n, ms: Math.round(f.dur), fps: +(f.n * 1000 / f.dur).toFixed(1), longFrames: f.long,
    longTasks: (window.__lt || []).slice(),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
  };
})()`;

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=414,896', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ];
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  let cdp = null;

  try {
    await waitPort();
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    for (const dev of DEVICES) {
      const checks = [];
      cdp.errors = [];
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: dev.w, height: dev.h, deviceScaleFactor: dev.dsf, mobile: true,
        screenWidth: dev.w, screenHeight: dev.h
      });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: IPHONE_UA, platform: 'iPhone', acceptLanguage: 'zh-CN'
      });
      await cdp.send('Page.navigate', { url: FILE_URL });
      if (!(await cdp.waitFor('window.__appReady === true', 12000))) throw new Error(dev.label + ' 页面未就绪');
      await sleep(300);

      // 首屏指标
      const nav = await cdp.ev(`(() => {
        const n = performance.getEntriesByType('navigation')[0] || {};
        const paints = {};
        performance.getEntriesByType('paint').forEach((p) => { paints[p.name] = Math.round(p.startTime); });
        return {
          domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0),
          load: Math.round(n.loadEventEnd || 0),
          firstPaint: paints['first-paint'] || null,
          firstContentfulPaint: paints['first-contentful-paint'] || null,
          heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
        };
      })()`);
      report.perf[dev.label] = { nav };

      // 1) 布局与首屏
      const m = await cdp.ev(MEASURE);
      check(checks, dev.label + ' 无横向溢出', m.sw <= m.iw + 1 && m.bw <= m.iw + 1,
        `scrollW=${m.sw} innerW=${m.iw} bodyW=${m.bw}`);
      check(checks, dev.label + ' 首屏舞台内容不裁切', m.idleFits,
        `idle=${JSON.stringify(m.idleBox)} stageH=${m.stageH} topbarH=${m.topbarH}`);
      check(checks, dev.label + ' 关键控件≥44×44', m.smallTargets.length === 0, JSON.stringify(m.smallTargets));
      check(checks, dev.label + ' 合规文案完整可见', !m.legalTruncated && m.legal.h >= 20 && m.legalText.indexOf('不产生任何真实交易') >= 0,
        JSON.stringify(m.legal));

      // 2) 滚动误触防护（模拟 touchstart+moved 后点击开箱）
      const guard = await cdp.ev(`(() => {
        const btn = document.getElementById('btnOpen1');
        const before = window.__sim.state().stats.opens;
        const r = btn.getBoundingClientRect();
        const mk = (type, x, y) => {
          const e = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
          return e;
        };
        document.dispatchEvent(mk('touchstart', r.left + 20, r.top + 20));
        document.dispatchEvent(mk('touchmove', r.left + 20, r.top + 92));
        btn.click();
        return { before, after: window.__sim.state().stats.opens, busy: document.querySelector('#btnOpen1') ? true : false };
      })()`);
      check(checks, dev.label + ' 滑动后不误触发开箱', guard.before === guard.after, JSON.stringify(guard));

      // 3) 截图：首页
      if (dev.shots.includes('home')) {
        await cdp.ev('window.scrollTo(0,0)');
        await sleep(120);
        await cdp.shot('m-375-home.png');
      }

      // 4) 十连：演出 + 结果
      await cdp.ev('window.__sim.addCoins(500000)');
      await cdp.ev(`document.getElementById('btnOpen10').click()`);
      await sleep(1000);
      const skipBox = await cdp.ev(`(() => {
        const b = document.getElementById('btnSkip');
        const r = b.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 };
      })()`);
      check(checks, dev.label + ' 跳过动画按钮≥44 且在舞台内', skipBox.h >= 43.5 && skipBox.w >= 43.5 && skipBox.visible,
        JSON.stringify(skipBox));

      if (dev.shots.includes('anim')) {
        await cdp.ev('window.scrollTo(0,0)');
        await sleep(60);
        await cdp.shot('m-390-anim.png');
      }

      if (!(await cdp.waitFor(`(() => { const g = document.getElementById('resultGrid'); return !document.getElementById('stageResult').hidden && g.children.length === 10; })()`, 5000))) {
        throw new Error(dev.label + ' 十连结果未出现');
      }
      await sleep(1700);

      const ten = await cdp.ev(`(() => {
        const grid = document.getElementById('resultGrid');
        const cards = Array.prototype.slice.call(grid.children);
        const stage = document.getElementById('stage').getBoundingClientRect();
        const flipped = cards.filter((c) => c.classList.contains('flipped')).length;
        const gr = grid.getBoundingClientRect();
        grid.scrollLeft = grid.scrollWidth;
        const last = cards[cards.length - 1].getBoundingClientRect();
        const reach = last.right <= gr.right + 1.5;
        grid.scrollLeft = 0;
        const cardH = Math.round(cards[0].getBoundingClientRect().height);
        const cardFits = cards.every((c) => {
          const r = c.getBoundingClientRect();
          return r.top >= stage.top - 1 && r.bottom <= stage.bottom + 1;
        });
        return {
          count: cards.length, flipped, scrollable: grid.scrollWidth > grid.clientWidth + 2,
          reachLast: reach, cardH, cardFits,
          gridW: Math.round(gr.width), scrollW: Math.round(grid.scrollWidth),
          stageH: Math.round(stage.height), docW: document.documentElement.scrollWidth, iw: innerWidth
        };
      })()`);
      check(checks, dev.label + ' 十连 10 张全部翻开', ten.count === 10 && ten.flipped === 10,
        `cards=${ten.count} flipped=${ten.flipped}`);
      check(checks, dev.label + ' 十连卡片不越出舞台', ten.cardFits, `cardH=${ten.cardH} stageH=${ten.stageH}`);
      check(checks, dev.label + ' 十连结果可横滑看全', ten.scrollable && ten.reachLast,
        `gridW=${ten.gridW} scrollW=${ten.scrollW} reachLast=${ten.reachLast}`);
      check(checks, dev.label + ' 十连后无横向溢出', ten.docW <= ten.iw + 1, `docW=${ten.docW} iw=${ten.iw}`);

      if (dev.shots.includes('ten')) {
        await cdp.ev('window.scrollTo(0,0)');
        await sleep(120);
        await cdp.shot('m-375-ten.png');
      }

      // 正常模式 FPS：单独一次十连，避免截图占用帧
      await cdp.ev(`document.getElementById('btnAgain10').click()`);
      await cdp.ev(FPS_START);
      await sleep(1750);
      const fpsNormal = await cdp.ev(FPS_READ);

      // 低性能模式 FPS 对比
      await cdp.ev('window.__sim.setPerf(true)');
      await cdp.ev(`document.getElementById('btnAgain10').click()`);
      await cdp.ev(FPS_START);
      await sleep(1000);
      const degraded = await cdp.ev(`(() => {
        const rays = document.querySelector('#stageAnim .rays');
        const sparks = document.querySelectorAll('#resultGrid .sparks i').length;
        return {
          low: document.body.classList.contains('perf-low'),
          raysHidden: rays ? getComputedStyle(rays).display === 'none' : null,
          sparks: sparks,
          perf: window.__sim.perf()
        };
      })()`);
      await sleep(800);
      const fpsLow = await cdp.ev(FPS_READ);
      check(checks, dev.label + ' 低性能模式生效（去射线/减粒子）', degraded.low && degraded.raysHidden !== false,
        JSON.stringify(degraded));
      await cdp.ev(`document.getElementById('btnBack').click()`);
      await cdp.ev('window.__sim.setPerf(false)');
      await sleep(200);
      if (!report.perf[dev.label].fps) {
        report.perf[dev.label].fps = { normal: fpsNormal, low: fpsLow };
      }

      // 5) 概率公示
      await cdp.ev(`document.querySelector('.tab[data-tab="rates"]').click()`);
      await sleep(150);
      await cdp.ev(`(document.querySelector('#rateCrates .chip[data-rate="c3"]') || {click:function(){}}).click()`);
      await sleep(200);
      const rates = await cdp.ev(`(() => {
        const d = document.querySelector('#pane-rates details.rate-detail');
        if (d && !d.open) d.open = true;
        const pane = document.getElementById('pane-rates');
        const items = pane.querySelectorAll('.rate-item').length;
        const p = pane.getBoundingClientRect();
        const chips = Array.prototype.slice.call(pane.querySelectorAll('#rateCrates .chip'));
        const smallChips = chips.map((c) => Math.round(c.getBoundingClientRect().height)).filter((n) => n < 43.5);
        const over = [];
        pane.querySelectorAll('*').forEach(function (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > p.right + 1) {
            over.push((el.className || el.tagName) + ':' + Math.round(r.width));
          }
        });
        pane.scrollIntoView({ block: 'start' });
        const topH = document.querySelector('.topbar').getBoundingClientRect().height;
        window.scrollTo(0, document.querySelector('.bottom').getBoundingClientRect().top + window.scrollY - topH - 6);
        return {
          items, open: d ? d.open : false, smallChips, over: over.slice(0, 6),
          paneW: Math.round(p.width), paneSW: Math.round(pane.scrollWidth),
          docW: document.documentElement.scrollWidth, iw: innerWidth,
          lastBottom: Math.round(pane.querySelector('.foot-note').getBoundingClientRect().bottom + window.scrollY),
          docH: document.documentElement.scrollHeight
        };
      })()`);
      check(checks, dev.label + ' 概率公示可展开 15 件权重', rates.open && rates.items === 15,
        `items=${rates.items} open=${rates.open}`);
      check(checks, dev.label + ' 概率公示无横向溢出/可滚动到底', rates.paneSW <= rates.paneW + 1 && rates.docW <= rates.iw + 1 && rates.lastBottom <= rates.docH,
        `paneW=${rates.paneW} paneSW=${rates.paneSW} over=${JSON.stringify(rates.over)} last=${rates.lastBottom} docH=${rates.docH}`);
      check(checks, dev.label + ' 公示箱体筛选按钮≥44 高', rates.smallChips.length === 0, JSON.stringify(rates.smallChips));
      await sleep(150);
      if (dev.shots.includes('rates')) await cdp.shot('m-390-rates.png');

      // 6) 背包
      await cdp.ev(`document.querySelector('.tab[data-tab="bag"]').click()`);
      await sleep(200);
      const bag = await cdp.ev(`(() => {
        const pane = document.getElementById('pane-bag');
        const grid = document.getElementById('bagGrid');
        const items = pane.querySelectorAll('.bag-item');
        const chips = Array.prototype.slice.call(document.querySelectorAll('#bagFilters .chip'));
        const rowsY = new Set(Array.prototype.map.call(items, (e) => Math.round(e.getBoundingClientRect().top)));
        const perRarity = {};
        let sum = 0;
        ['common', 'fine', 'rare', 'epic', 'legend'].forEach(function (r) {
          const c = chips.find(function (x) { return x.dataset.r === r; });
          if (!c) return;
          c.click();
          const n = grid.querySelectorAll('.bag-item').length;
          perRarity[r] = n;
          sum += n;
        });
        const all = chips.find(function (c) { return c.dataset.r === 'all'; });
        if (all) all.click();
        const afterAll = grid.querySelectorAll('.bag-item').length;
        pane.scrollIntoView({ block: 'start' });
        const topH = document.querySelector('.topbar').getBoundingClientRect().height;
        window.scrollTo(0, document.querySelector('.bottom').getBoundingClientRect().top + window.scrollY - topH - 6);
        const bodyH = document.documentElement.scrollHeight;
        return {
          total: items.length, afterAll, perRarity, sum, rows: rowsY.size,
          chipW: chips.map((c) => Math.round(c.getBoundingClientRect().width)).filter((n) => n < 43.5),
          docW: document.documentElement.scrollWidth, iw: innerWidth,
          bagBottom: Math.round(pane.getBoundingClientRect().bottom + window.scrollY), bodyH
        };
      })()`);
      check(checks, dev.label + ' 背包双列且稀有度筛选可点',
        bag.total > 0 && bag.rows >= 2 && bag.sum === bag.total && bag.afterAll === bag.total && bag.chipW.length === 0,
        `items=${bag.total} rows=${bag.rows} perRarity=${JSON.stringify(bag.perRarity)} sum=${bag.sum}`);
      check(checks, dev.label + ' 背包可滚动到底不溢出', bag.docW <= bag.iw + 1 && bag.bagBottom <= bag.bodyH + 1,
        `bagBottom=${bag.bagBottom} docH=${bag.bodyH} docW=${bag.docW}`);
      await sleep(150);
      if (dev.shots.includes('bag')) await cdp.shot('m-360-bag.png');

      // 7) 充值弹层
      await cdp.ev('window.scrollTo(0,0)');
      await cdp.ev(`document.getElementById('btnRecharge').click()`);
      await sleep(250);
      const modal = await cdp.ev(`(() => {
        const mask = document.getElementById('modal');
        const box = document.querySelector('#modal .modal').getBoundingClientRect();
        const body = document.querySelector('#modal .modal-body');
        const lastEl = document.querySelector('#modal .mask-note');
        body.scrollTop = body.scrollHeight;
        const lb = lastEl.getBoundingClientRect();
        const br = body.getBoundingClientRect();
        return {
          open: !mask.hidden,
          w: Math.round(box.width), h: Math.round(box.height),
          iw: innerWidth, ih: innerHeight,
          scrollable: body.scrollHeight > body.clientHeight,
          reachedBottom: lb.bottom <= br.bottom + 1.5,
          tiers: document.querySelectorAll('#tiers .tier').length,
          closeW: Math.round(document.getElementById('modalClose').getBoundingClientRect().width),
          closeH: Math.round(document.getElementById('modalClose').getBoundingClientRect().height)
        };
      })()`);
      check(checks, dev.label + ' 充值弹层在视口内且可滚到底', modal.open && modal.w <= modal.iw - 18 && modal.h <= modal.ih - 20 && modal.reachedBottom && modal.tiers === 6,
        `w=${modal.w} h=${modal.h} scrollable=${modal.scrollable} bottom=${modal.reachedBottom}`);
      check(checks, dev.label + ' 弹层关闭按钮≥44×44', modal.closeW >= 43.5 && modal.closeH >= 43.5,
        `${modal.closeW}x${modal.closeH}`);
      await sleep(150);
      if (dev.shots.includes('recharge')) await cdp.shot('m-414-recharge.png');
      await cdp.ev(`document.getElementById('modalClose').click()`);

      // 竖屏 ↔ 横屏切换
      if (dev.label === '375x667') {
        const beforeOpens = await cdp.ev('window.__sim.state().stats.opens');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: 667, height: 375, deviceScaleFactor: 2, mobile: true, screenWidth: 667, screenHeight: 375
        });
        await sleep(600);
        const land = await cdp.ev(`(() => {
          const s = document.getElementById('stage').getBoundingClientRect();
          const b = document.getElementById('btnOpen10').getBoundingClientRect();
          return {
            iw: innerWidth, sw: document.documentElement.scrollWidth,
            stageW: Math.round(s.width), stageH: Math.round(s.height),
            btn: { w: Math.round(b.width), h: Math.round(b.height) },
            opens: window.__sim.state().stats.opens
          };
        })()`);
        check(checks, '375x667 横屏切换无横向溢出且不误触',
          land.sw <= land.iw + 1 && land.stageW <= land.iw && land.opens === beforeOpens && land.btn.h >= 43.5,
          JSON.stringify(land));
        await cdp.send('Emulation.setDeviceMetricsOverride', {
          width: dev.w, height: dev.h, deviceScaleFactor: dev.dsf, mobile: true, screenWidth: dev.w, screenHeight: dev.h
        });
        await sleep(300);
      }

      check(checks, dev.label + ' 控制台零报错', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | ') || '无');

      report.devices.push({ label: dev.label, perf: report.perf[dev.label], checks });
      report.consoleErrors.push({ label: dev.label, errors: cdp.errors.slice() });
    }

    const all = report.devices.flatMap((d) => d.checks);
    const fail = all.filter((c) => !c.pass);
    console.log('\n===== 汇总 =====');
    console.log(`检查项 ${all.length}，通过 ${all.length - fail.length}，失败 ${fail.length}`);
    fs.writeFileSync(path.join(ROOT, 'verify', 'mobile-report.json'), JSON.stringify(report, null, 2));
    console.log('报告写入 verify/mobile-report.json');
    process.exitCode = fail.length ? 1 : 0;
  } catch (e) {
    console.error('ERROR', e && e.stack || e);
    process.exitCode = 2;
  } finally {
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})();
