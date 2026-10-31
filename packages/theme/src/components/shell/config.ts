import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { localizeConfig,t } from '../../lib/locale';
import type { Site } from '../../lib/types';

/** Public browser configuration only; editor/provider credentials never enter this object. */
export function browserConfig(site:Site,lang:string,pageType:string,title:string) {
  const config=localizeConfig(site,lang), e=config.extra, tr=(key:string)=>t(key,lang,site);
  const comments=e.comments || {}, code=e.code || {}, search=e.search || {};
  // Collection chapters use the same TOC and reading controls as standalone articles.
  const isPost=['post','collection-content','collection-detail'].includes(pageType);
  const friends=['public','static'].some(dir=>existsSync(resolve(site.root,dir,`data/friends.${lang}.json`)))?`/data/friends.${lang}.json`:'/data/friends.json';
  return {
    htmlType:isPost?'post':'page',postTitle:title,language:lang,isPost,isHome:pageType==='index',isMusic:pageType==='music',
    i18n:Object.fromEntries(['back_top','today','old_browser','close','outdated'].map(key=>[key,tr(key)])),
    copy:{success:tr('copied')},passageTip:e.post?.passage_tip||{enable:false,day:365},
    copyright:{enable:Boolean(e.post?.copyrights?.copy_info),limitCount:10,languages:{author:tr('copyright_author')+config.author,link:tr('copyright_link'),source:tr('copyright_source')+config.title,info:tr('copyright_info')}},
    lightbox:'fancybox',rightMenuEnable:Boolean(e.tool?.right_menu?.enable),
    lazyload:{enable:Boolean(e.other?.lazyload?.enable),error:e.other?.lazyload?.error_img||'/img/404.svg'},
    umamiTrackExternalLink:Boolean(e.site.analytics?.umami?.track_external_link),isFriendLinksInFooter:Boolean(e.footer?.footer_group?.enable),
    loadingBox:Boolean(e.other?.loading_box?.enable),loadProgressBar:Boolean(e.other?.loading_box?.progress_bar),progress_bar:Boolean(e.other?.loading_box?.progress_bar),
    navMusicEnable:Boolean(e.tool?.nav_music?.enable),helloText:[...(e.about?.author_info_left_tags||[]),...(e.about?.author_info_right_tags||[])],profileStyle:e.sidebar?.profile?.profile_style||'default',
    enable:Boolean(e.tool?.right_menu?.enable),keyboard:Boolean(e.tool?.keyboard),
    date_suffix:{just:tr('just'),min:tr('min_ago'),hour:tr('hour_ago'),day:tr('days_ago'),month:tr('month_ago')},
    Snackbar:{chs_to_cht:tr('traditional_enabled'),cht_to_chs:tr('simplified_enabled'),day_to_night:tr('dark_enabled'),night_to_day:tr('light_enabled'),bgLight:e.style?.theme_light_skin,bgDark:e.style?.theme_dark_skin,position:'top-center'},
    translate:{defaultEncoding:e.style?.translate?.default_encoding||2,translateDelay:0,msgToTraditionalChinese:'繁',msgToSimplifiedChinese:'简',rightMenuMsgToTraditionalChinese:'轉為繁體',rightMenuMsgToSimplifiedChinese:'转为简体'},
    prism:{enable:Boolean(code.enable),enable_title:Boolean(code.enable_title),enable_hr:Boolean(code.enable_hr),enable_line:Boolean(code.enable_line),enable_copy:Boolean(code.enable_copy),enable_expander:Boolean(code.enable_expander),prism_limit:(code.height_limit||300)+30,enable_height_limit:Boolean(code.enable_height_limit)},
    search:{engine:e.nav?.right?.search_engine||'meilisearch',algolia:{appId:search.algolia?.app_id,apiKey:search.algolia?.app_key,indexName:search.algolia?.index_name},meilisearch:{host:search.meilisearch?.host,apiKey:search.meilisearch?.key,indexName:search.meilisearch?.index_name},hits:{per_page:6},languages:{input_placeholder:tr('search_input'),hits_empty:tr('search_empty'),hits_stats:tr('search_stats')}},
    source:{
      power:e.sidebar?.power||{},links:{linksUrl:e.friend?.links_url,dataUrl:friends,linksNum:e.footer?.footer_group?.num||3},jQuery:'/libs/jquery/jquery-3.7.1.min.js',
      justifiedGallery:{js:'/libs/justified-gallery/fjGallery.min.js',css:'/libs/justified-gallery/fjGallery.css'},fancybox:{js:'/libs/fancybox/jquery.fancybox.min.js',css:'/dist/css/global.css'},
      comments:{use:comments.system,maxBarrage:comments.barrage?.max_barrage,barrageTime:comments.barrage?.barrage_time,mailMd5:comments.barrage?.mail_md5,lazyload:comments.lazy_load,textarea:comments.system==='twikoo'?'el-textarea__inner':comments.system==='artalk'?'atk-textarea':'wl-editor'},
      post:{dynamicBackground:Boolean(e.post?.dynamicBackground)},tool:{switch:Boolean(e.tool?.snackbar?.switch)},
      postAi:{gptName:e.post?.abstract?.gpt_name,modeName:e.post?.abstract?.mode||'local',switchBtn:e.post?.abstract?.switch_btn,keys:e.post?.abstract?.key,btnLink:e.post?.abstract?.btn_link,Referers:e.post?.abstract?.referers,basicWordCount:e.post?.abstract?.basic_word_count,randomNum:e.post?.abstract?.random_num},
      twikoo:{js:comments.twikoo?.js||comments.twikoo?.js_url||'/libs/twikoo/twikoo.all.min.js',twikooUrl:comments.twikoo?.env_id},
      artalk:{js:comments.artalk?.artalk_js||'/libs/artalk/Artalk.js',css:comments.artalk?.artalk_css||'/libs/artalk/Artalk.css',artalkUrl:comments.artalk?.server,siteName:comments.artalk?.site_name},
      waline:{js:comments.waline?.waline_js||'https://cdn.cbd.int/@waline/client@2.15.7/dist/waline.js',serverURL:comments.waline?.server_url,locale:comments.waline?.locale||''},
      footer:{default_enable:Boolean(e.footer?.enable)},about:{rewardList:[],rewardAmount:e.about_reward?.reward_number||0}
    }
  };
}
