import { cp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';
import { patchToml } from '../../server/content.ts';
export async function prepareBrowserFixture(site) {
  const example=fileURLToPath(new URL('../../../../examples/demo/',import.meta.url));
  await cp(example,site,{recursive:true,filter:file=>!/(?:^|\/)(?:dist|node_modules|\.astro|\.astro-assets)(?:\/|$)/.test(file)});
  const assetRoot=join(site,'public');await mkdir(join(assetRoot,'img'),{recursive:true});
  const image=await sharp(await readFile(new URL('../../../../packages/theme/assets/img/logo.svg',import.meta.url))).webp().toBuffer();
  await writeFile(join(assetRoot,'img/logo.webp'),image);
  await writeFile(join(site,'data.toml'),patchToml(await readFile(join(site,'data.toml'),'utf8'),{
    'post.tags':[{id:'tech',name:'技术'},{id:'project',name:'项目'}],
    'post.categories':[{id:'misc',name:'杂项'}],
    'equipment.groups':[{name:'Work',items:[{name:'Example laptop'}]},{name:'Travel',items:[]}],
    'skill.items':[{name:'Example skill',svg_symbol_id:'javascript'}],
    'menu.nav_menu':[{name:'Explore',menus:[{name:'Home',href:'/',icon:'icon-home'}]}],
  }));
  await writeFile(join(site,'config.toml'),patchToml(await readFile(join(site,'config.toml'),'utf8'),{
    'extra.about.widget_list':['hello-about','author-career'],
    'extra.about.author_info_left_tags':['💻 数码科技爱好者'],
    'extra.sidebar.widgets.indexWidget':[{widget:'profile'}],
    'extra.about.photos':[{url:'/img/logo.webp',alt:'Example photo'}],
    'extra.about_reward.sponsors':[{name:'Example A',date:'2020-01-01'},{name:'Example B',date:'2020-01-02'}],
  }));
  await writeFile(join(assetRoot,'data/friends.json'),JSON.stringify({groups:[{name:'Examples',links:[{name:'Example',url:'https://example.com',logo:'/img/logo.webp'}]}]}));
  const subscribe=join(site,'content/pages/subscribe.md');await writeFile(subscribe,(await readFile(subscribe,'utf8'))+'\n{{ subscribe_list() }}\n');
  for(const [file,layout]of [['docs/_index.md','collection-category'],['docs/user/_index.md','collection-detail'],['docs/user/01 intro.md','collection-content']]){
    const target=join(site,'content/collections',file);await mkdir(join(target,'..'),{recursive:true});await writeFile(target,`+++\ntitle="Guide"\nlayout="${layout}"\ndate=2020-01-01\n+++\nA fictional guide for browser testing.\n`);
  }
  return site;
}
