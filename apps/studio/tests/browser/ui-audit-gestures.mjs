import { settleLayout } from './ui-audit-inspection.mjs';

export const AUDIT_SIZES = [[320,568],[390,844],[844,390],[768,1024],[1024,768],[1440,1000]];
export const SYNTHETIC_LIMITATIONS = [
  'Headless Chromium viewport/touch emulation and CDP synthetic gestures, not a physical touchscreen or OS accessibility zoom.',
  'visualViewport.scale proves Chromium visual pinch zoom only; it does not validate Safari/WKWebView, Android WebView, native gesture recognizers, soft keyboards or safe-area hardware.',
  'Wheel/touch tests sample the largest hit-testable scroll container per surface (including the active dialog); other nested scrollers are not exhaustively traversed. No-scroll surfaces receive input but are explicitly not applicable, not passed scrolling.',
  '200% reflow uses half the CSS viewport dimensions with scale 1, the layout equivalent of desktop 200% zoom; it is not pinch, OS text scaling or browser chrome zoom evidence.',
  'Native-only connection, OAuth, recovery, workspace and client API states are delegated to native-ui.mjs with mocked Tauri IPC, not native WebView evidence.',
];

export async function configureGestureEmulation(page, client, { width, height, deviceScaleFactor = 1, mobile = false, hasTouch = mobile }, resetScale = true) {
  // Reapply after screenshots: Puppeteer can restore its own (different) metrics.
  // CDP changes do not update page.viewport() or trigger Puppeteer's mobile reload.
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: hasTouch, maxTouchPoints: 5 });
  if (resetScale) await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await settleLayout(page);
}

export async function configureViewport(page, client, width, height, touch = width <= 1024) {
  // Keep Puppeteer mobile flags constant: changing isMobile would reload and lose dialogs.
  const previous = page.viewport();
  await page.setViewport({ width, height, deviceScaleFactor: 1, isMobile: previous?.isMobile ?? false, hasTouch: previous?.hasTouch ?? false });
  await configureGestureEmulation(page, client, { width, height, mobile: touch });
}

export async function inspectGestureEnvironment(page, point) {
  return page.evaluate(point => {
    // Geometry/styles only: never collect field values, text or credentials.
    const describe = node => {
      if (!node) return null;
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return { tag:node.tagName, id:node.id, className:node.getAttribute('class'),
        overflowX:style.overflowX, overflowY:style.overflowY, touchAction:style.touchAction,
        overscrollBehaviorY:style.overscrollBehaviorY, pointerEvents:style.pointerEvents,
        top:node.scrollTop, max:node.scrollHeight-node.clientHeight,
        box:{left:rect.left,top:rect.top,width:rect.width,height:rect.height} };
    };
    const hit = point ? document.elementFromPoint(point.x,point.y) : null;
    const ancestors = [];
    for (let node = hit; node; node = node.parentElement) ancestors.push(describe(node));
    return { layout:{width:innerWidth,height:innerHeight}, visual:visualViewport ? {
      width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,
      offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop,
    } : null, maxTouchPoints:navigator.maxTouchPoints, visibility:document.visibilityState,
      viewportMeta:document.querySelector('meta[name=viewport]')?.content ?? null,
      root:describe(document.documentElement), body:describe(document.body),
      scrollingElement:describe(document.scrollingElement), point:point ?? null, hitAncestors:ancestors };
  }, point);
}

async function positions(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-ui-audit-scroll]')].map(node => ({
    id: node.dataset.uiAuditScroll, top: node.scrollTop, max: node.scrollHeight - node.clientHeight,
  })));
}

async function waitForScroll(page) {
  // Settle by observed scroll offsets across frames, with a finite frame budget.
  await page.evaluate(() => new Promise(resolve => {
    let last = '', stable = 0, frames = 0;
    const sample = () => {
      const next = [...document.querySelectorAll('[data-ui-audit-scroll]')].map(node => node.scrollTop).join(',');
      stable = next === last ? stable + 1 : 0; last = next;
      if (++frames >= 90 || (frames >= 8 && stable >= 5)) resolve(); else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

export async function exerciseScroll(page, client, { touch, onDown, onUp }) {
  const viewport = page.viewport();
  if (viewport) await configureGestureEmulation(page, client, { ...viewport, mobile:touch, hasTouch:touch });
  const environment = await inspectGestureEnvironment(page);
  const selection = await page.evaluate(() => {
    document.querySelectorAll('[data-ui-audit-scroll]').forEach(node => node.removeAttribute('data-ui-audit-scroll'));
    const modal = [...document.querySelectorAll('dialog[open]')].at(-1);
    const overlay = document.querySelector('.modal,[role=dialog]');
    const drawer = document.querySelector('.sidebar.open');
    const root = modal || overlay || drawer || document.body;
    const drawerRequired = root === drawer;
    const pool = [...root.querySelectorAll('*'), root];
    if (!modal && root === document.body) pool.push(document.scrollingElement);
    // Keep the document root eligible even when overflow is hidden: a tall but
    // locked page must fail movement, not silently become a no-scroll N/A result.
    const candidates = pool.filter((node, index) => {
      if (pool.indexOf(node) !== index || node.closest('[inert]')) return false;
      if (node.closest('.sidebar') && !node.closest('.sidebar.open')) return false;
      const s = getComputedStyle(node);
      return node.scrollHeight > node.clientHeight + 3 && (node === document.scrollingElement || /(auto|scroll)/.test(s.overflowY));
    }).map(node => {
      const r = node === document.scrollingElement ? {left:0,top:0,right:innerWidth,bottom:innerHeight} : node.getBoundingClientRect();
      const left = Math.max(0,r.left), right = Math.min(innerWidth,r.right), top = Math.max(0,r.top), bottom = Math.min(innerHeight,r.bottom);
      if (right-left < 30 || bottom-top < 40) return null;
      const points = [[.5,.55],[.8,.55],[.5,.8]];
      const point = points.map(([x,y]) => ({x:Math.round(left+(right-left)*x),y:Math.round(top+(bottom-top)*y)})).find(({x,y}) => {
        const hit = document.elementFromPoint(x,y);
        // A nested scroller must be tested separately, not mistaken for its parent.
        for (let p = hit; p; p = p.parentElement) {
          if (p === node) return true;
          if (p.scrollHeight > p.clientHeight+3 && /(auto|scroll)/.test(getComputedStyle(p).overflowY)) return false;
        }
        return node === document.scrollingElement && !!hit;
      });
      return point ? {node,point,area:(right-left)*(bottom-top)} : null;
    }).filter(Boolean).sort((a,b) => b.area-a.area).slice(0,1);
    const targets = candidates.map(({node,point}, i) => {
      node.dataset.uiAuditScroll = String(i);
      return { id:String(i), name:node.className || node.tagName, point, initial:node.scrollTop, max:node.scrollHeight-node.clientHeight };
    });
    // An open drawer is expected to scroll internally, never via the locked background.
    const drawerTargetValid = !drawerRequired || candidates.length === 1 && candidates.every(({node,point}) => {
      const hit = document.elementFromPoint(point.x,point.y);
      return drawer.contains(node) && node.contains(hit) && node.scrollHeight > node.clientHeight + 3;
    });
    return { targets, drawerRequired, drawerTargetValid };
  });
  const { targets } = selection;
  const results = [], failures = [];
  if (selection.drawerRequired && !selection.drawerTargetValid) {
    failures.push({type:'scroll-target-selection',target:'open-drawer'});
    return { environment, results, failures };
  }
  // Even a short non-scroll surface receives real wheel/touch input; movement is N/A.
  if (!targets.length) targets.push({ id:null, name:'non-scrollable-surface', point:await gestureCenter(page), initial:0,max:0 });
  for (const method of touch ? ['wheel','cdp-touch'] : ['wheel']) {
    for (const target of targets) {
      // Screenshots in callbacks may restore Puppeteer's desktop metrics.
      if (viewport) await configureGestureEmulation(page, client, { ...viewport, mobile:touch, hasTouch:touch });
      const diagnostic = await inspectGestureEnvironment(page, target.point);
      const before = await positions(page);
      const distance = Math.min(160, Math.max(20, target.point.y-16));
      const send = async direction => {
        if (method === 'wheel') {
          await page.mouse.move(target.point.x,target.point.y);
          await page.mouse.wheel({ deltaY:direction*distance });
        } else await client.send('Input.synthesizeScrollGesture', {
          x:target.point.x, y:target.point.y, yDistance:-direction*distance,
          gestureSourceType:'touch', speed:700, preventFling:true,
        });
        await waitForScroll(page);
      };
      const observation = { method, target:target.name, point:target.point, applicable:target.max > 3, before, diagnostic };
      try {
        // Move up first to make room for the downward assertion at an existing bottom.
        await send(-1);
        observation.start = await positions(page);
        await send(1);
        observation.down = await positions(page);
        if (onDown && results.length === 0) {
          await onDown();
          if (viewport) await configureGestureEmulation(page, client, { ...viewport, mobile:touch, hasTouch:touch });
        }
        await send(-1);
        observation.up = await positions(page);
        if (onUp && results.length === 0) {
          await onUp();
          if (viewport) await configureGestureEmulation(page, client, { ...viewport, mobile:touch, hasTouch:touch });
        }
        const get = values => values.find(value => value.id === target.id)?.top ?? 0;
        const downChanged = get(observation.down) > get(observation.start) + 1;
        const upChanged = get(observation.up) < get(observation.down) - 1;
        if (observation.applicable && (!downChanged || !upChanged)) failures.push({type:'scroll-did-not-move',method,target:target.name,downChanged,upChanged});
        observation.status = observation.applicable ? downChanged && upChanged ? 'passed' : 'failed' : 'not-applicable';
        // Finite input-only return toward the top for the following inspection.
        await send(-1);
      } catch (error) {
        observation.status = 'failed';
        failures.push({type:'scroll-exercise-error',method,target:target.name,message:error.message});
      }
      results.push(observation);
    }
  }
  return { environment, results, failures };
}

async function gestureCenter(page) {
  return page.evaluate(() => {
    const root = [...document.querySelectorAll('dialog[open]')].filter(node => node.matches(':modal')).at(-1)
      || document.querySelector('.save-mode-menu,.sidebar.open');
    const r = root?.getBoundingClientRect() || {left:0,top:0,right:innerWidth,bottom:innerHeight};
    return {x:Math.round((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2),y:Math.round((Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2)};
  });
}

export async function exercisePinch(page, client, onZoomed, onRestored) {
  const read = () => page.evaluate(() => ({scale:visualViewport?.scale ?? 1,width:visualViewport?.width ?? innerWidth,height:visualViewport?.height ?? innerHeight}));
  const result = { method:'CDP Input.synthesizePinchGesture / touch', failures:[] };
  try {
    const viewport = page.viewport();
    if (viewport) await configureGestureEmulation(page, client, { ...viewport, mobile:true, hasTouch:true });
    const before = result.before = await read(), center = result.center = await gestureCenter(page);
    result.environment = await inspectGestureEnvironment(page, center);
    await client.send('Input.synthesizePinchGesture', {...center,scaleFactor:1.7,relativeSpeed:800,gestureSourceType:'touch'});
    await page.waitForFunction(scale => visualViewport.scale > scale + .05, {timeout:2500}, before.scale).catch(() => {});
    result.zoomed = await read();
    if (result.zoomed.scale <= before.scale + .05 || result.zoomed.width >= before.width - 1) result.failures.push({type:'pinch-no-visible-scale-change'});
    if (onZoomed) {
      await onZoomed();
      if (viewport) await configureGestureEmulation(page, client, { ...viewport, mobile:true, hasTouch:true }, false);
    }
    result.beforeRestore = await read();
    if (Math.abs(result.beforeRestore.scale-result.zoomed.scale)>.06) result.failures.push({type:'pinch-scale-changed-between-gestures'});
    await client.send('Input.synthesizePinchGesture', {...center,scaleFactor:before.scale/result.zoomed.scale,relativeSpeed:800,gestureSourceType:'touch'});
    await page.waitForFunction(scale => Math.abs(visualViewport.scale-scale)<.06,{timeout:2500},before.scale).catch(() => {});
    result.restored = await read();
    if (Math.abs(result.restored.scale-before.scale)>.06) result.failures.push({type:'pinch-did-not-restore'});
    // Capture the observed reverse-gesture result before any cleanup scale reset.
    if (onRestored) await onRestored();
  } catch (error) {
    result.failures.push({type:'pinch-protocol-error',message:error.message});
  } finally {
    // Cleanup is not evidence of successful gesture restoration.
    try {
      await client.send('Emulation.setPageScaleFactor',{pageScaleFactor:1});
      await settleLayout(page);
      result.cleanup = await read();
    } catch (error) {
      result.failures.push({type:'pinch-cleanup-error',message:error.message});
    }
  }
  result.status = result.failures.length ? 'failed' : 'passed';
  return result;
}
