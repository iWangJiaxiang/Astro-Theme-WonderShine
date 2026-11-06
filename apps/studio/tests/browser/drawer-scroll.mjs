import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { configureGestureEmulation } from './ui-audit-gestures.mjs';

// Independent acceptance: never change exerciseScroll's candidates or findings.
const selectors = {
  first: '.sidebar-navigation nav button',
  last: '.sidebar-navigation nav:last-of-type button:last-child',
  logout: '.sidebar-bottom button',
  trigger: '.mobile-menu',
};

async function snapshot(page) {
  return page.evaluate(selectors => {
    const nav = document.querySelector('.sidebar-navigation');
    const sidebar = document.querySelector('.sidebar');
    const root = document.scrollingElement;
    const view = visualViewport;
    const visual = { left:view?.offsetLeft ?? 0, top:view?.offsetTop ?? 0,
      width:view?.width ?? innerWidth, height:view?.height ?? innerHeight, scale:view?.scale ?? 1 };
    const box = node => {
      const r = node.getBoundingClientRect();
      return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
    };
    const offsets = node => node ? { top:node.scrollTop, left:node.scrollLeft,
      max:node.scrollHeight-node.clientHeight, clientHeight:node.clientHeight, scrollHeight:node.scrollHeight } : null;
    const ancestors = hit => {
      const result = [];
      for (let p = hit; p; p = p.parentElement) result.push({ tag:p.tagName, nav:p === nav, sidebar:p === sidebar });
      return result;
    };
    const control = (node, withinNav = false) => {
      if (!node) return null;
      const rect = box(node), style = getComputedStyle(node);
      let left = visual.left, top = visual.top, right = left+visual.width, bottom = top+visual.height;
      for (let p = node.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p), b = box(p);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top,b.top); bottom = Math.min(bottom,b.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left,b.left); right = Math.min(right,b.right); }
      }
      const n = nav && box(nav);
      const samples = [.5,.1,.9].map(fraction => {
        const point = { x:rect.left+rect.width*fraction, y:rect.top+rect.height/2 };
        const hit = document.elementFromPoint(point.x,point.y);
        return { point, owned:!!hit && node.contains(hit), ancestors:ancestors(hit) };
      });
      return { rect, interactive:!node.disabled && !node.closest('[inert],[hidden],details:not([open])') &&
          style.display !== 'none' && style.visibility === 'visible' && style.pointerEvents !== 'none',
        fullyVisible:rect.width > 0 && rect.height > 0 && rect.left >= left && rect.top >= top && rect.right <= right && rect.bottom <= bottom,
        withinNav:!withinNav || !!n && rect.left >= n.left && rect.top >= n.top && rect.right <= n.right && rect.bottom <= n.bottom,
        current:node.getAttribute('aria-current') === 'page', samples };
    };
    const n = nav && box(nav);
    const point = n ? { x:n.left+n.width/2, y:n.top+n.height/2 } : null;
    const strokeHits = point ? [-60,60].map(offset => {
      const p = {x:point.x,y:point.y+offset};
      return {point:p,ancestors:ancestors(document.elementFromPoint(p.x,p.y))};
    }) : [];
    return { layout:{width:innerWidth,height:innerHeight}, visual,
      runtime:{devicePixelRatio,maxTouchPoints:navigator.maxTouchPoints,timeOrigin:performance.timeOrigin},
      sidebar:sidebar ? {rect:box(sidebar),open:sidebar.classList.contains('open'),inert:sidebar.inert} : null,
      nav:nav ? {rect:n,...offsets(nav),overflowY:getComputedStyle(nav).overflowY} : null,
      root:offsets(root), bodyOverflowY:getComputedStyle(document.body).overflowY,
      closeFocused:document.activeElement === document.querySelector('.navigation-close'),
      point, hitAncestors:point ? ancestors(document.elementFromPoint(point.x,point.y)) : [], strokeHits,
      controls:Object.fromEntries(Object.entries(selectors).map(([key,selector]) => [key,control(document.querySelector(selector),key === 'first' || key === 'last')])) };
  }, selectors);
}

function assertControl(control, name) {
  assert.ok(control?.interactive && control.fullyVisible && control.withinNav && control.samples.every(sample => sample.owned),
    `${name} must be fully visible, interactive and hit-testable at center and edges`);
}

function assertInputState(state) {
  assert.equal(state.visual.scale, 1, 'Drawer input requires measured scale 1');
  assert.equal(state.visual.left, 0, 'Drawer input requires unpanned viewport');
  assert.equal(state.visual.top, 0, 'Drawer input requires unpanned viewport');
  assert.ok(state.sidebar?.open && !state.sidebar.inert, 'Drawer must remain open and interactive');
  assert.ok(state.nav?.max > 3 && /^(auto|scroll)$/.test(state.nav.overflowY), 'Explicit nav must overflow');
  assert.ok(state.hitAncestors.some(node => node.nav), 'Actual input point must hit the nav ancestor chain');
  assert.ok(state.point.x > state.nav.rect.left && state.point.x < state.nav.rect.right &&
    state.point.y > state.nav.rect.top && state.point.y < state.nav.rect.bottom &&
    state.point.x >= 0 && state.point.x < state.visual.width && state.point.y >= 0 && state.point.y < state.visual.height,
  'Actual input point must be inside nav and visual viewport');
  assert.equal(state.bodyOverflowY, 'hidden', 'Open drawer must lock the background body');
  assert.equal(state.closeFocused, true, 'Scrolling must not move focus away from close');
  assertControl(state.controls.logout, 'Logout (not activated)');
}

async function settleScroll(page) {
  await page.evaluate(() => new Promise((resolve,reject) => {
    let last = '', stable = 0, frames = 0;
    const sample = () => {
      const nav = document.querySelector('.sidebar-navigation'), root = document.scrollingElement;
      const next = `${nav?.scrollTop},${root?.scrollTop},${root?.scrollLeft}`;
      stable = next === last ? stable+1 : 0; last = next;
      if (++frames >= 8 && stable >= 5) resolve();
      else if (frames >= 90) reject(new Error('Drawer offsets did not settle within frame budget'));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

export async function checkDrawerScroll({ page, screenshots, waitForDrawer }) {
  const viewport = page.viewport();
  assert.ok(viewport && ((viewport.width === 320 && viewport.height === 568) ||
    (viewport.width === 390 && viewport.height === 844)), 'Drawer acceptance has two explicit sizes');
  const size = `${viewport.width}x${viewport.height}`;
  const report = { schemaVersion:1, size, status:'running', phase:'setup', steps:[], methods:{},
    limitations:['Headless Chromium wheel and one-finger CDP dispatch only; not real-device or native WebView evidence.',
      'Logout is checked without activation; pinch, keyboard occlusion and safe-area hardware are not covered.'], cleanup:{} };
  let client, baseline, touchState = 'idle', failure;
  const configure = () => configureGestureEmulation(page,client,{...viewport,mobile:true,hasTouch:true});
  const record = async phase => {
    report.phase = phase;
    const entry = { phase, state:await snapshot(page) }; report.steps.push(entry); return entry.state;
  };
  const touch = async (type, points) => {
    touchState = 'unknown';
    await client.send('Input.dispatchTouchEvent',{type,touchPoints:points.map(({x,y}) => ({id:0,x,y,radiusX:1,radiusY:1,force:1}))});
    touchState = type === 'touchEnd' || type === 'touchCancel' ? 'idle' : 'active';
  };
  const input = async (method, direction, phase) => {
    report.phase = phase;
    assert.equal(touchState, 'idle', 'Never continue with active or unknown touch');
    const before = await snapshot(page);
    const entry = {phase,method,direction,before}; report.steps.push(entry);
    assertInputState(before);
    const {x,y} = before.point;
    if (method === 'wheel') {
      entry.input = {point:{x,y},deltaY:direction*160};
      await page.mouse.move(x,y);
      await page.mouse.wheel({deltaY:direction*160});
    } else {
      // Both endpoints are fixed in the measured scale-1 nav; no clamp or retry.
      const from = {x,y:y+direction*60}, to = {x,y:y-direction*60};
      entry.input = {from,to,moves:16};
      assert.ok([from,to].every(p => p.y > before.nav.rect.top && p.y < before.nav.rect.bottom &&
        p.y >= 0 && p.y < before.visual.height && p.x >= 0 && p.x < before.visual.width), 'Touch stroke must fit the actual nav');
      assert.ok(before.strokeHits.every(hit => hit.ancestors.some(node => node.nav)), 'Both actual touch endpoints must hit nav');
      await touch('touchStart',[from]);
      for (let i = 1; i <= 16; i++) {
        await touch('touchMove',[{x:from.x+(to.x-from.x)*i/16,y:from.y+(to.y-from.y)*i/16}]);
        await delay(16);
      }
      await touch('touchEnd',[]);
    }
    await settleScroll(page);
    const after = entry.after = await snapshot(page);
    assertInputState(after);
    assert.ok(direction*(after.nav.top-before.nav.top) > 1, `${phase}: one deliberate input must move nav in the requested direction`);
    assert.equal(after.root.top,before.root.top, `${phase}: background document must stay locked`);
    assert.equal(after.root.left,before.root.left, `${phase}: background document must not pan`);
    return after;
  };
  const toBoundary = async (direction, phase) => {
    let state = await record(`${phase}-before`);
    for (let i = 0; i < 8; i++) {
      if (direction > 0 ? state.nav.max-state.nav.top <= 1 : state.nav.top <= 1) break;
      state = await input('wheel',direction,`${phase}-chunk-${i+1}`);
    }
    assert.ok(direction > 0 ? state.nav.max-state.nav.top <= 1 : state.nav.top <= 1, `${phase}: must reach boundary within eight progressing inputs`);
    return state;
  };
  const physicalClick = async (name, phase) => {
    const state = await record(phase);
    assert.equal(state.visual.scale,1,'Clicks require measured scale 1');
    assertControl(state.controls[name],name);
    const center = state.controls[name].samples[0].point;
    await page.mouse.move(center.x,center.y);
    await page.mouse.click(center.x,center.y);
  };
  const reopen = async phase => {
    await physicalClick('trigger',`${phase}-trigger`);
    await waitForDrawer(page,true);
    await page.waitForFunction(() => document.activeElement === document.querySelector('.navigation-close'));
    assertInputState(await record(`${phase}-open`));
  };
  try {
    baseline = await record('before-emulation');
    client = await page.createCDPSession();
    await configure();
    const initial = await record('initial');
    assertInputState(initial);
    assert.equal(initial.nav.top,0,'Acceptance starts at nav top, without a DOM scroll reset');
    assert.equal(initial.controls.first.current,true,'Acceptance starts on dashboard');
    for (const method of ['wheel','dispatch-touch']) {
      const observation = report.methods[method] = {status:'running'};
      observation.before = await record(`${method}-before`);
      observation.down = await input(method,1,`${method}-down`);
      observation.up = await input(method,-1,`${method}-up`);
      observation.status = 'passed';
    }
    const bottom = await toBoundary(1,'bottom-reach');
    assertInputState(bottom);
    assertControl(bottom.controls.last,'Last navigation button');
    report.phase = 'bottom-screenshot';
    report.bottomScreenshot = `navigation-bottom-${size}.png`;
    await page.screenshot({path:`${screenshots}/${report.bottomScreenshot}`,fullPage:false});
    await configure(); // Screenshots may restore Puppeteer's non-mobile metrics.
    const afterScreenshot = await record('bottom-after-screenshot');
    assertInputState(afterScreenshot);
    assert.ok(afterScreenshot.nav.max-afterScreenshot.nav.top <= 1, 'Screenshot must not invalidate observed bottom');
    assertControl(afterScreenshot.controls.last,'Last navigation button after screenshot');
    await physicalClick('last','last-navigation-activation');
    await waitForDrawer(page,false);
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-current') === 'page' &&
      !document.querySelector('[aria-busy="true"]'),{},selectors.last);
    await record('last-navigation-activated');
    await reopen('restore-dashboard');
    await toBoundary(-1,'restore-top');
    await physicalClick('first','dashboard-activation');
    await waitForDrawer(page,false);
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-current') === 'page' &&
      !!document.querySelector('.thread-composer textarea') && !document.querySelector('[aria-busy="true"]'),{},selectors.first);
    await record('dashboard-activated');
    await reopen('return-to-keyboard-checks');
    const final = await record('final');
    assert.equal(final.controls.first.current,true,'Dashboard must be restored');
    assert.equal(final.closeFocused,true,'Keyboard checks must resume with close focused');
    report.status = 'passed';
  } catch (error) {
    failure = error;
    // Do not persist browser messages/HTML, labels, identity or field values.
    report.failure = {phase:report.phase,kind:error.name};
    for (const observation of Object.values(report.methods)) {
      if (observation.status === 'running') observation.status = 'failed';
    }
    report.status = 'failed';
  } finally {
    const cleanup = async (name, run) => {
      try { await run(); report.cleanup[name] = 'completed'; }
      catch (error) {
        report.cleanup[name] = {status:'failed',kind:error.name};
        failure = failure ? new AggregateError([failure,error],'Drawer acceptance/cleanup failed') : error;
        report.status = 'failed';
      }
    };
    await cleanup('finalObservation',async () => { report.finalObservation = await snapshot(page); });
    report.cleanup.touchStateBefore = touchState;
    if (client) {
      if (touchState !== 'idle') await cleanup('cancelTouch',() => touch('touchCancel',[]));
      else report.cleanup.cancelTouch = 'skipped-idle';
      // Detaching can revoke this session's metrics override. Restore only after
      // detach, through Puppeteer's surviving emulation owner, not this client.
      await cleanup('detach',() => client.detach());
      report.cleanup.requestedEmulation = {width:viewport.width,height:viewport.height,
        deviceScaleFactor:viewport.deviceScaleFactor ?? 1,isMobile:viewport.isMobile ?? false,
        hasTouch:viewport.hasTouch ?? false,isLandscape:viewport.isLandscape ?? false};
      await cleanup('restoreEmulation',async () => {
        // In pinned Puppeteer 25.16.0, emulateViewport creates a fresh state
        // object per call; #applyViewport's cache uses object identity. A fresh
        // call reissues metrics/touch without toggling mobile flags or reloading.
        await page.setViewport({...viewport});
        await settleScroll(page);
      });
      await cleanup('verifyRestoredEmulation',async () => {
        const state = report.cleanup.restoredObservation = await snapshot(page);
        const requested = report.cleanup.requestedEmulation;
        const actual = page.viewport();
        assert.ok(actual, 'Puppeteer must retain an explicit viewport');
        assert.equal(actual.width,requested.width);
        assert.equal(actual.height,requested.height);
        assert.equal(actual.deviceScaleFactor ?? 1,requested.deviceScaleFactor);
        assert.equal(actual.isMobile ?? false,requested.isMobile);
        assert.equal(actual.hasTouch ?? false,requested.hasTouch);
        assert.equal(actual.isLandscape ?? false,requested.isLandscape);
        assert.equal(state.layout.width,requested.width,'Post-detach layout width must be restored');
        assert.equal(state.layout.height,requested.height,'Post-detach layout height must be restored');
        assert.equal(state.visual.width,requested.width);
        assert.equal(state.visual.height,requested.height);
        assert.equal(state.visual.scale,1,'Post-detach visual scale must remain one');
        assert.equal(state.visual.left,0);
        assert.equal(state.visual.top,0);
        assert.equal(state.runtime.devicePixelRatio,requested.deviceScaleFactor);
        assert.equal(state.runtime.maxTouchPoints,baseline.runtime.maxTouchPoints,'Restore original touch capability');
        assert.equal(state.runtime.maxTouchPoints > 0,requested.hasTouch,'Touch capability must agree with Puppeteer flags');
        assert.equal(state.runtime.timeOrigin,baseline.runtime.timeOrigin,'Cleanup must not reload the document');
        assert.ok(state.sidebar?.open && !state.sidebar.inert,'Post-detach drawer must remain open');
        assert.equal(state.closeFocused,true,'Post-detach close must still own focus');
        assert.equal(state.controls.first.current,true,'Post-detach dashboard must remain active');
        assertControl(state.controls.logout,'Post-detach logout (not activated)');
      });
    }
    report.cleanup.touchStateAfter = touchState;
    // Always preserve per-size structural evidence, including failed assertions.
    await writeFile(`${screenshots}/navigation-scroll-${size}.json`,JSON.stringify(report,null,2)+'\n');
  }
  if (failure) throw failure;
}
