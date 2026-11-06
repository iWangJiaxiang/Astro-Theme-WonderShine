// DOM-wide inspection includes body portals; it never changes production styles.
export async function settleLayout(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

export async function inspectLayout(page, { mobile = false, reflow = false } = {}) {
  return page.evaluate(({ mobile, reflow }) => {
    const findings = [], warnings = [];
    const modal = [...document.querySelectorAll('dialog[open]')].filter(node => node.matches(':modal')).at(-1) || document.querySelector('.save-mode-menu[role=dialog]');
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return node.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none' &&
        Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0 && !node.closest('[inert]') && (!modal || modal.contains(node));
    };
    const label = node => (node.getAttribute('aria-label') || node.name || node.id || node.labels?.[0]?.textContent || node.textContent || node.className || node.tagName).trim().slice(0, 110);
    const box = node => {
      const r = node.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const add = (type, node, extra = {}) => findings.push({ type, name: label(node), box: box(node), ...extra });
    if (document.documentElement.scrollWidth > innerWidth + 1) findings.push({ type: 'page-overflow', width: document.documentElement.scrollWidth, viewport: innerWidth });
    const controls = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=radio],[contenteditable=true]')].filter(visible);
    let hitTested = 0;
    const candidates = controls.map(node => ({ node, r: node.getBoundingClientRect() }));
    for (const { node, r } of candidates) {
      const style = getComputedStyle(node);
      // File inputs may intentionally be visually hidden behind an upload label.
      if (node.matches('input[type=file]') || r.width < 1 || r.height < 1) continue;
      const scroller = (() => { for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth + 1) return p; } })();
      if ((r.left < -1 || r.right > innerWidth + 1) && !scroller) add('control-overflow', node);
      if (mobile && node.matches('input:not([type=checkbox]):not([type=radio]):not([type=color]),textarea,select,[contenteditable=true]') && parseFloat(style.fontSize) < 16) add('input-font-below-16', node, { fontSize: style.fontSize });
      if (mobile && (r.width < 44 || r.height < 44)) {
        warnings.push({ type: 'target-below-44-recommendation', name: label(node), box: box(node) });
        // WCAG 2.5.8 spacing exception, label-equivalent and inline-link exceptions.
        const inline = node.matches('a') && style.display === 'inline';
        const equivalent = node.matches('input[type=checkbox],input[type=radio]') && [...(node.labels || [])].some(l => l.getBoundingClientRect().width >= 24 && l.getBoundingClientRect().height >= 24);
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        const crowded = candidates.some(other => {
          if (other.node === node || node.contains(other.node) || other.node.contains(node)) return false;
          const b = other.r;
          if (b.width < 24 || b.height < 24) return Math.hypot(cx - (b.left + b.right) / 2, cy - (b.top + b.bottom) / 2) < 24;
          return Math.hypot(cx - Math.max(b.left, Math.min(cx, b.right)), cy - Math.max(b.top, Math.min(cy, b.bottom))) < 12;
        });
        if ((r.width < 24 || r.height < 24) && crowded && !inline && !equivalent) add('target-below-24-without-spacing', node);
      }
      // Custom radios/checkboxes often delegate their entire hit area to a label.
      // Test that equivalent target, rather than reporting the decorative input as covered.
      if (node.matches('a') && style.display === 'inline' && node.getClientRects().length > 1) {
        // Wrapped inline link bounding boxes include blank gaps between line fragments.
        warnings.push({type:'wrapped-inline-link-hit-test-not-sampled',name:label(node)});
        continue;
      }
      const labelTarget = node.matches('input[type=checkbox],input[type=radio]')
        ? [...(node.labels || [])].find(candidate => visible(candidate)) : null;
      const hitTarget = labelTarget || node;
      const hitRect = hitTarget.getBoundingClientRect();
      // Hit test only the truly visible, clipped portion, not offscreen controls.
      let left = Math.max(0, hitRect.left), right = Math.min(innerWidth, hitRect.right), top = Math.max(0, hitRect.top), bottom = Math.min(innerHeight, hitRect.bottom);
      for (let p = hitTarget.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p), b = p.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      }
      if (right - left < 3 || bottom - top < 3 || node.disabled) continue;
      // A strip hidden under a sticky header is not a usable sampled target;
      // require a substantial portion of its box before declaring occlusion.
      if (bottom-top < Math.min(hitRect.height*.6,20) || right-left < Math.min(hitRect.width*.6,20)) continue;
      const points = [[.5,.5],[.25,.5],[.75,.5]].map(([x,y]) => [left + (right-left)*x, top+(bottom-top)*y]);
      hitTested++;
      const hits = points.map(([x,y]) => document.elementFromPoint(x,y));
      if (!hits.some(hit => hit && (hitTarget === hit || hitTarget.contains(hit)))) add('control-occluded', node, { blockers: hits.map(hit => hit ? label(hit) : null), hitTarget:label(hitTarget) });
    }
    for (const node of document.querySelectorAll('dialog[open],[role=dialog]')) {
      if (!visible(node)) continue;
      const r = node.getBoundingClientRect();
      // Full-screen overlays are allowed; the inner modal panel must still fit.
      if (r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1) add('dialog-outside-viewport', node);
    }
    for (const field of document.querySelectorAll('.field-inline')) {
      const [a,b] = field.children;
      if (!a || !b || !visible(a) || !visible(b)) continue;
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      if (Math.min(x.right,y.right)-Math.max(x.left,y.left)>1 && Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)>1) add('label-control-overlap', a);
    }
    return { findings, warnings, controls: controls.length, hitTested, reflow,
      viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale ?? null },
      portals: [...document.querySelectorAll('dialog[open],[role=dialog],.modal')].filter(visible).map(node => ({ name: label(node), box: box(node), inAppRoot: !!node.closest('#app,#root') })) };
  }, { mobile, reflow });
}
