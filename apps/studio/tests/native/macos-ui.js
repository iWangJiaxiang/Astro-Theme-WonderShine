(async () => {
  if (window.__studioSmokeRunning) return;
  window.__studioSmokeRunning = true;
  const config = window.__studioSmokeConfig;
  const profilesKey = 'wondershine.native.workspaces.v1';
  const marker = 'studio-native-smoke:' + config.profile.id;
  if (!sessionStorage.getItem(marker)) {
    sessionStorage.setItem(marker, JSON.stringify({ profiles: localStorage.getItem(profilesKey), language: localStorage.getItem('studio-language') }));
    localStorage.setItem(profilesKey, JSON.stringify([config.profile]));
    localStorage.setItem('studio-language', 'zh-CN');
    location.reload(); return;
  }
  const results = [];
  window.confirm = () => true;
  const alerts = []; window.alert = message => alerts.push(String(message));
  const progress = async () => window.__TAURI_INTERNALS__.invoke('plugin:fs|write_file', new TextEncoder().encode(JSON.stringify({results})), { headers: {path: encodeURIComponent(config.resultPath + '.progress'), options: '{}'} });
  await progress();
  const wait = async (fn, description) => {
    const start = Date.now();
    while (!fn()) { if (alerts.length) throw new Error('Unexpected App alert: ' + alerts.join('; ')); if (Date.now() - start > 20000) throw new Error('Timeout: ' + description + '; ' + document.body.innerText.slice(-900)); await new Promise(resolve => setTimeout(resolve, 60)); }
    return fn();
  };
  const text = () => document.body.innerText;
  const click = async label => {
    const button = await wait(() => [...document.querySelectorAll('button')].find(node => node.textContent.trim().replace(/^✦\s*/, '') === label && !node.disabled), label);
    button.click();
  };
  const input = async (selector, value) => {
    const node = await wait(() => document.querySelector(selector), selector);
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
  };
  const configField = async (label, value) => {
    const node = await wait(() => [...document.querySelectorAll('.native-ai-settings label')].find(node => node.querySelector('span')?.textContent === label)?.querySelector('input'), label);
    node.dataset.smokeInput = 'active'; await input('[data-smoke-input="active"]', value); delete node.dataset.smokeInput;
  };
  const notice = () => wait(() => document.querySelector('.notice.success'), 'save success');
  const heading = title => wait(() => [...document.querySelectorAll('h1')].some(node => node.textContent === title), title);
  let error;
  try {
    await click('打开工作区'); await heading('今天，写点什么？'); results.push('offline-open'); await progress();
    if (config.restoreOnly) {
      await click('媒体库');
      await wait(() => [...document.querySelectorAll('.media-thumbnail img')].some(img => img.naturalWidth > 0), 'persisted local asset permission');
      results.push('restart-restores-local-filesystem-and-asset-scope'); return;
    }
    await click('客户端 API 设置');
    await configField('API 地址', config.endpoint);
    await configField('文本模型', 'fixture-text');
    await configField('图片模型（可选）', 'fixture-image');
    await configField('API Key', 'fixture-native-only');
    await click('保存 API 配置'); await notice();
    if (JSON.stringify(localStorage).includes('fixture-native-only')) throw new Error('API key persisted');
    results.push('client-configuration-key-redaction'); await progress();
    await click('文章');
    const article = await wait(() => [...document.querySelectorAll('button')].find(node => node.textContent.includes('Native acceptance article')), 'fixture article'); article.click();
    await heading('Native acceptance article');
    await input('.markdown-source', 'Actual macOS WebView edit.'); await click('本地保存'); await notice(); results.push('native-filesystem-save'); await progress();
    await click('AI 摘要'); await click('生成摘要');
    await wait(() => document.querySelector('[aria-label="AI 摘要结果"]')?.value === 'Actual native provider summary.', 'native HTTP summary');
    await click('应用摘要'); await click('本地保存'); await notice(); results.push('native-http-summary-save'); await progress();
    await click('AI 生成封面'); await click('生成提示词');
    await wait(() => document.querySelector('[aria-label="图片提示词"]')?.value, 'cover prompt');
    await click('生成图片'); await wait(() => document.querySelector('.ai-image-preview img')?.naturalWidth > 0, 'cover preview');
    await click('保存并设为封面'); await wait(() => !document.querySelector('.ai-assistant-dialog'), 'cover applied'); await click('本地保存'); await notice(); results.push('native-http-image-media-save'); await progress();
    await click('＋ 添加语言'); await click('AI 翻译为草稿');
    await heading('Native translated article'); results.push('native-ai-translation-draft'); await progress();
    await click('工作区同步'); await wait(() => document.querySelector('.workspace-status-grid'), 'workspace status'); await click('提交到设备');
    await wait(() => text().includes('已提交到设备，尚未推送到远端。'), 'local commit'); results.push('native-git-commit'); await progress();
    document.querySelector('[aria-label="退出登录"]').click(); await heading('连接创作工作区');
    await click('打开工作区'); await heading('今天，写点什么？'); await click('客户端 API 设置');
    await wait(() => text().includes('尚未配置密钥'), 'key cleared after reconnect');
    if (document.querySelector('.native-ai-settings input[type="url"]').value !== config.endpoint) throw new Error('Preferences not restored');
    results.push('offline-reopen-clears-key-retains-settings'); await progress();
    document.querySelector('[aria-label="退出登录"]').click(); await heading('连接创作工作区');
  } catch (reason) { error = String(reason); }
  finally {
    const previous = JSON.parse(sessionStorage.getItem(marker));
    if (previous.profiles === null) localStorage.removeItem(profilesKey); else localStorage.setItem(profilesKey, previous.profiles);
    if (previous.language === null) localStorage.removeItem('studio-language'); else localStorage.setItem('studio-language', previous.language);
    localStorage.removeItem('wondershine.native.ai.v1:' + config.profile.id);
    sessionStorage.removeItem(marker);
    await window.__TAURI_INTERNALS__.invoke('plugin:fs|write_file', new TextEncoder().encode(JSON.stringify({ results, error })), { headers: { path: encodeURIComponent(config.resultPath), options: '{}' } });
  }
})();
