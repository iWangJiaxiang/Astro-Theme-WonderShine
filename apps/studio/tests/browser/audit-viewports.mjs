// Keep screenshots at representative sizes and measure both sides of each CSS breakpoint.
const screenshots = new Map([
  [320, 568], [390, 844], [768, 1024], [844, 390],
  [1024, 768], [1440, 1000], [1920, 1080],
]);

export async function auditViewports(page) {
  const boundaries = await page.evaluate(() => {
    const widths = new Set([2560]);
    function visit(rules) {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          for (const match of rule.conditionText.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)) {
            const width = Number(match[2]);
            widths.add(width);
            widths.add(width + (match[1] === 'max' ? 1 : -1));
          }
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) {
      if (!sheet.href || new URL(sheet.href).origin === location.origin) visit(sheet.cssRules);
    }
    return [...widths].filter(width => width >= 320 && width <= 2560);
  });
  const widths = [...new Set([...screenshots.keys(), ...boundaries])].sort((a, b) => a - b);
  return widths.map(width => ({
    width,
    height: screenshots.get(width) ?? (width < 768 ? 844 : 900),
    screenshot: screenshots.has(width),
  }));
}
