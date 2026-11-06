import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import { LocalRepository } from '../server/repository.js';
import { ContentService } from '../server/content-service.js';
import { mergeLocaleData } from '../server/localized-settings.js';
import { getValue } from '../server/content.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'studio-locale-settings-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(root + '.studio-revisions-v1', { recursive: true, force: true }); });
  const repo = new LocalRepository(root), content = new ContentService(repo);
  await repo.write('config.toml', 'default_language="zh"\n[languages.en]\n[extra.equipment]\nbig_title="装备"\nsmall_title="基础副标题"\n[extra.about.careers]\ntitle="职业"\ncolor="blue"\n[extra.about_reward]\nenable=true\n[extra.locale.en.about.careers]\ntitle="Career"\n', null);
  await repo.write('data.toml', '[post]\ntags=[{id="r",name="研究"}]\ncategories=[{id="c",name="生活"}]\n[skill]\nsvg_sprite="/icons.svg"\nitems=[{name="共同技能"}]\n', null);
  await repo.write('public/data/friends.json', JSON.stringify({ groups: [{ name: '朋友', links: [] }], custom: 'keep' }), null);
  return { repo, content };
}

test('config locale overrides deeply inherit fields and never overwrite default-language authored content', async t => {
  const { repo, content } = await fixture(t);
  const about = await content.settings('about', 'en');
  assert.equal(getValue(about.values['extra.about.careers'], 'title'), 'Career');
  assert.equal(getValue(about.values['extra.about.careers'], 'color'), 'blue');
  const settings = await content.settings('page-equipment-header', 'en');
  const identity = JSON.parse(settings.revision) as unknown[];
  assert.equal(identity[0], 'settings-v2');
  assert.equal(identity[1], 'en');
  assert.equal(identity[2], 'config.toml');
  assert.equal(identity[3], (await repo.read('config.toml'))!.revision);
  const result = await content.saveSettings(settings.id, { 'extra.equipment.big_title': 'Equipment' }, settings.revision, 'en');
  const saved = await content.settings(settings.id, 'en');
  assert.equal(result.revision, saved.revision);
  assert.equal(saved.values['extra.equipment.big_title'], 'Equipment');
  assert.equal(saved.values['extra.equipment.small_title'], '基础副标题');
  assert.equal((await content.settings(settings.id)).values['extra.equipment.big_title'], '装备');
  const raw = parse((await repo.read('config.toml'))!.text);
  assert.deepEqual(JSON.parse(JSON.stringify(getValue(raw, 'extra.locale.en.equipment'))), { big_title: 'Equipment' });
  const reward = await content.settings('page-about-reward', 'en');
  await content.saveSettings(reward.id, { 'extra.about_reward.enable': false, 'extra.about_reward.title': '' }, reward.revision, 'en');
  assert.equal((await content.settings(reward.id, 'en')).values['extra.about_reward.enable'], false);
  assert.equal((await content.settings(reward.id)).values['extra.about_reward.enable'], true);
});

test('data and dynamic friends use independent language files with minimal authored overrides', async t => {
  const { repo, content } = await fixture(t);
  const tags = await content.settings('taxonomies', 'en');
  assert.equal(tags.file, 'data.en.toml');
  const saved = await content.saveSettings(tags.id, { 'post.tags': [{ id: 'r', name: 'Research' }] }, tags.revision, 'en');
  assert.equal(saved.revision, (await content.settings(tags.id, 'en')).revision);
  assert.deepEqual((await content.settings(tags.id, 'en')).values['post.categories'], [{ id: 'c', name: '生活', index: 0 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(parse((await repo.read('data.en.toml'))!.text))), { post: { tags: [{ id: 'r', name: 'Research' }] } });
  const skill = await content.settings('page-about-skills', 'en');
  await content.saveSettings(skill.id, { 'skill.items': [] }, skill.revision, 'en');
  assert.deepEqual((await content.settings(skill.id, 'en')).values['skill.items'], []);
  assert.equal((await content.settings(skill.id, 'en')).values['skill.svg_sprite'], '/icons.svg');
  const friends = await content.settings('friends', 'en');
  assert.equal(friends.file, 'public/data/friends.en.json');
  await content.saveSettings(friends.id, { groups: [{ name: 'Friends', links: [] }] }, friends.revision, 'en');
  assert.deepEqual(JSON.parse((await repo.read('public/data/friends.en.json'))!.text), { groups: [{ name: 'Friends', links: [] }] });
  assert.equal((JSON.parse((await repo.read('public/data/friends.json'))!.text)).custom, 'keep');
});

test('base edits invalidate inherited locale revisions and unsupported language or global groups are rejected', async t => {
  const { repo, content } = await fixture(t);
  const local = await content.settings('taxonomies', 'en');
  const base = await content.settings('taxonomies');
  await content.saveSettings(base.id, { 'post.categories': [] }, base.revision);
  await assert.rejects(content.saveSettings(local.id, { 'post.tags': [] }, local.revision, 'en'), /文件已更新/);
  assert.equal(await repo.read('data.en.toml'), null);
  for (const language of ['fr', '../en', 'en.extra', '__proto__']) await assert.rejects(content.settings('about', language), /语言未在/);
  await assert.rejects(content.settings('site', 'en'), /全站设置/);
  await assert.rejects(content.settings('appearance', 'en'), /全站设置/);
  const current = await content.settings('page-about-skills', 'en');
  await assert.rejects(content.saveSettings(current.id, { 'extra.about.hello': 'Wrong schema' }, current.revision, 'en'), /不允许修改/);
});
test('explicit default-language settings also conflict when language configuration changes', async t => {
  const { repo, content } = await fixture(t);
  const original = await content.settings('taxonomies', 'zh');
  const config = (await repo.read('config.toml'))!;
  await repo.write('config.toml', config.text + '\n[languages.fr]\n', config.revision);
  await assert.rejects(content.saveSettings(original.id, { 'post.tags': [] }, original.revision, 'zh'), /文件已更新/);
  const before = await repo.read('data.toml');
  const fresh = await content.settings('taxonomies', 'zh');
  const saved = await content.saveSettings(fresh.id, { 'post.tags': [] }, fresh.revision, 'zh');
  assert.equal(saved.revision, (await content.settings(fresh.id, 'zh')).revision);
  assert.notEqual((await repo.read('data.toml'))?.revision, before?.revision);
});

test('locale merge replaces arrays and preserves explicit false, zero, empty and null values', () => {
  assert.deepEqual(mergeLocaleData({ a: { x: 1, y: [1], z: true }, title: 'Base' }, { a: { y: [], z: false }, title: '', count: 0, extra: null }), { a: { x: 1, y: [], z: false }, title: '', count: 0, extra: null });
});
