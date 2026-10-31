/** Author-managed page settings retained from the Markdown/TOML site. */
export interface Skill { name: string; logo?: string; icon?: string; svg_symbol_id?: string; svg_sprite?: string; bg_color?: string }
export interface Friend { display_name: string; url: string; description?: string; logo?: string; local_logo?: string; siteshot?: string; label?: string; label_color?: string }
export interface FriendGroup { display_name?: string; description?: string; display_style?: string; items?: Friend[]; links?: Friend[] }
export interface Equipment { name: string; img?: string; model?: string; description?: string; button_url?: string; button_title?: string }
export interface EquipmentGroup { name: string; description?: string; items?: Equipment[] }
export interface Sponsor { name: string; amount: number; date?: string; avatar?: string }
interface TextCard { tittle?: string; textarea_up?: string; textarea_down?: string }
interface Hobby { tips?: string; title?: string; uid?: string; class?: string; url?: string; bg_url?: string }
interface Preference { tips?: string; title?: string; bottom?: string; link?: string; bg?: string }
export interface AboutSettings {
  author_info_left_tags?: string[];
  author_info_right_tags?: string[];
  widget_list?: string[];
  content?: string;
  idea?: string;
  hello?: string;
  careers?: { title?: string; bg?: string; tags?: {background?: string; occupation?: string}[] };
  photos?: {url: string; description?: string}[];
  textarea_left?: TextCard;
  textarea_right?: TextCard;
  hobbies?: Hobby[];
  hobby?: {loading_bar?: string};
  like?: Preference;
  music?: Preference;
  map?: {StrengthenTitle?: string; background?: string; backgroundDark?: string; authorInfo?: {authorInfoTitle?: string; authorInfoContent?: string; authorInfoColor?: string}[]};
}
