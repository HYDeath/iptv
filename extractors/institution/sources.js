/** Institution-specific module definitions. Each selector isolates its own upstream discovery. */
import * as campus from './providers/campus.mjs';
import * as museum from './providers/museum.mjs';
import * as shanghai from './providers/shanghai.mjs';
import * as zhejiang from './providers/zhejiang.mjs';
import * as culturecloud from './providers/culturecloud.mjs';
import * as universities from './providers/universities.mjs';
import * as regionalculture from './providers/regionalculture.mjs';
import * as performingarts from './providers/performingarts.mjs';
import * as knowledge from './providers/knowledge.mjs';
import * as ceremonies from './providers/ceremonies.mjs';
import * as conferences from './providers/conferences.mjs';
import * as auctions from './providers/auctions.mjs';
import * as stages from './providers/stages.mjs';

const source = (id, name, selector, adapter, officialUrl, description, international = false) => Object.freeze({
  id, name, providerId: adapter.provider.id, selector, officialUrl, description, adapter, international,
});

export const SOURCES = Object.freeze([
  source('inst-xjtu', '西安交通大学', '西安交通大学思源直播', campus, 'https://zhibo.xjtu.edu.cn/', '思源直播官网公开讲座与校园活动；仅在官方确认在播时标为直播，其余为回放。'),
  source('inst-jlu', '吉林大学', '吉林大学电视台', campus, 'https://tv.jlu.edu.cn/', '吉林大学电视台公开会议、典礼和晚会录像；官方媒体证书失效时仅采用已核验的同主机 HTTP。'),
  source('inst-chnmuseum', '国家博物馆', '国家博物馆 · 国博云播', museum, museum.provider.officialUrl, '国博云播官网公开讲堂回放，动态获取最新四场非宗教讲座。'),
  source('inst-shqyg', '上海市群众艺术馆', '上海市群众艺术馆', shanghai, shanghai.provider.officialUrl, '官方文化直录播活动与公开录像；预告和已结束的直播地址不会标为在播。'),
  source('inst-zjwhg', '浙江省文化馆', '浙江省数字文化馆', zhejiang, zhejiang.provider.officialUrl, '浙江省数字文化馆公开演出；直播与独立回放地址分别处理。'),
  source('inst-culturecloud', '国家公共文化云', '国家公共文化云', culturecloud, culturecloud.provider.officialUrl, '国家公共文化云当前匿名分支开放的活动直播与回看，排除收费、试看和未开放内容。'),
  source('inst-fudan', '复旦大学', '复旦大学', universities, 'https://news.fudan.edu.cn/xysh/list.htm', '复旦大学新闻文化网公开校园影像、毕业短片与原创 MV，当前选取三条。'),
  source('inst-bnu', '北京师范大学', '北京师范大学', universities, 'https://video.bnu.edu.cn/', '北京师范大学视频空间官方校园专题、历史歌会与影像回放，当前选取三条。'),
  source('inst-hust', '华中科技大学', '华中科技大学', universities, 'https://www.hust.edu.cn/', '华中科技大学官网“华科大·影像”校园宣传与人物专题短片，当前选取三条。'),
  source('inst-gdwhg', '广东省文化馆', '广东省文化馆', regionalculture, 'https://www.gdscc.cn/whzx/web/index.html', '广东省文化馆官网公开群众文艺活动、村晚及音乐会，当前选取三条回放。'),
  source('inst-hnwhg', '湖南省文化馆', '湖南省文化馆', regionalculture, 'https://hns-whg.cn/Cloud/index.html', '湖南省文化馆官方原生直播与公开回看；部分回放使用 HEVC，需要播放器支持。'),
  source('inst-gzdjy', '广州大剧院', '广州大剧院', performingarts, 'https://gdm.gzdjy.org/local/86_36/cloudtheater.html', '广州大剧院云剧院公开歌谣夜及艺术导赏回放；官方媒体证书失效时仅采用已核验的同主机 HTTP。'),
  source('inst-ccom', '中央音乐学院', '中央音乐学院', performingarts, 'https://video.ccom.edu.cn/', '中央音乐学院官网匿名权限公开的国乐琼思演奏分集，播放前重新核验权限。'),
  source('inst-shlib', '上海图书馆', '上海图书馆', knowledge, 'https://www.library.sh.cn/service/video', '上海图书馆公开讲座回放，从官网指定的授权播放器动态获取当前媒体。'),
  source('inst-cdstm', '中国数字科技馆', '中国数字科技馆', knowledge, 'https://www.cdstm.cn/', '中国数字科技馆科普活动公开回放，仅收录主办方明确开启完整匿名回看的场次。'),
  source('inst-stvf', '上海电视节', '上海电视节 · 白玉兰奖', ceremonies, 'https://www.stvf.com/list?cid=101241203064743633521357224677381478', '上海电视节官网白玉兰奖颁奖典礼全程回顾，当前选取三场完整回放。'),
  source('inst-siff', '上海国际电影节', '上海国际电影节 · 金爵奖', ceremonies, 'https://www.siff.com/list?cid=import-319', '上海国际电影节官网金爵奖颁奖典礼全程回顾，当前选取三场完整回放。'),
  source('inst-zgc', '中关村论坛', '中关村论坛', conferences, 'https://www.zgcforum.com.cn/zh2026/live', '中关村论坛官网已经开启公开回看的会场录像；排除口令、额外验证和观众注册要求。'),
  source('inst-shforum', '上海论坛组委会', '上海论坛组委会', conferences, 'https://shanghaiforum.fudan.edu.cn/19462/list.htm', '上海论坛组委会官网嘉宾单场演讲回放；当前三条为 480p HEVC，需要播放器支持。'),
  source('inst-phillips', '富艺斯', '富艺斯 Phillips', auctions, 'https://www.phillips.com/', '富艺斯官方拍卖预展及拍后回顾短片；当前不提供整场拍卖，不操作竞买或交易。部署网络须可访问官方境外媒体。', true),
  source('inst-elb', '易北爱乐音乐厅', '易北爱乐音乐厅 · Elbphilharmonie', stages, stages.provider.officialUrl, '音乐厅官网指定的 NDR／ARD 公开长篇音乐会，遵守原有地区、登录和 DRM 限制；部署网络须可访问官方境外媒体。', true),
]);
