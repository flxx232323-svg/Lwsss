'use strict';

// ── Browse Cache Helper ──
const { cacheGet: _bcGet, cacheSet: _bcSet } = require('../utils/cache');
async function _cached(key, ttl, fn) {
  const hit = _bcGet(key);
  if (hit !== undefined && hit !== null) return hit;
  const data = await fn();
  _bcSet(key, data, ttl);
  return data;
}

var { reg: cbReg }   = require('../utils/cbRegistry');
var common           = require('../utils/common');
var escMd            = common.escMd;
var buildPath        = common.buildPath;
var starsDisplay     = common.starsDisplay;
var safeInt          = require('../utils/validate').safeInt;
var { cacheGet, cacheSet, cacheClear, cacheClearPrefix } = require('../utils/cache');
var reportsDb        = require('../database/reports');
var content          = require('../database/content');
var bundlesDb        = require('../database/bundles');
var commentsDb       = require('../database/comments');
var filesDb          = require('../database/files');
var interactions     = require('../database/interactions');
var { build, btn, back, backMenu, btnSpec } = require('../utils/keyboard');
var { eos }          = require('../utils/helpers');
var { all } = require('../database/db');
var PS = 50;

async function getPathData(spId, yrId, smId, sbId, catId) {
  var key = 'path_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId;
  var cached = cacheGet(key);
  if (cached) return cached;
  var results = await Promise.all([
    spId  && spId  !== 0 ? content.getSpec(spId)      : null,
    yrId  && yrId  !== 0 ? content.getYear(yrId)      : null,
    smId  && smId  !== 0 ? content.getSemester(smId)  : null,
    sbId  && sbId  !== 0 ? content.getSubject(sbId)   : null,
    catId && catId !== 0 ? content.getCategory(catId) : null,
  ]);
  var r = { sp:results[0], yr:results[1], sm:results[2], sb:results[3], cat:results[4] };
  cacheSet(key, r, 86400000);
  return r;
}

async function showSpecs(ctx) {
  ctx.answerCbQuery('').catch(function() {});
  var specs = cacheGet('specs_all');
  if (!specs) { specs = await content.getSpecs(); cacheSet('specs_all', specs, 21600000); }
  var rows = [];
  for (var _i = 0; _i < specs.length; _i += 2) {
    var _r = [btnSpec(specs[_i].name, 'sp_'+specs[_i].id)];
    if (specs[_i+1]) _r.push(btnSpec(specs[_i+1].name, 'sp_'+specs[_i+1].id));
    rows.push(_r);
  }
  rows.push(back('main_menu'));
  return eos(ctx, '🎓 *اختر تخصصك:*', { parse_mode:'Markdown', ...build(rows) });
}

async function showYears(ctx, spId, page) {
  ctx.answerCbQuery('').catch(function() {});
  spId = safeInt(spId); page = safeInt(page);
  var ckey = 'yrs_'+spId;
  var yd = cacheGet(ckey);
  if (!yd) {
    var r = await Promise.all([content.getSpec(spId), content.getYears(spId)]);
    yd = { sp:r[0], all:r[1] };
    cacheSet(ckey, yd, 21600000);
  }
  var sp=yd.sp, all=yd.all, total=all.length;
  var years = all.slice(page*PS, (page+1)*PS);
  if (!years.length) return eos(ctx, '📭 لا توجد سنوات.', build([backMenu('browse')]));
  var rows = years.map(function(y){ return [btn('📅 '+y.name, 'yr_'+spId+'_'+y.id)]; });
  if (total > PS) {
    var nav = [];
    if (page > 0) nav.push(btn('⬅️', 'yr_page_'+spId+'_'+(page-1)));
    nav.push(btn((page+1)+'/'+Math.ceil(total/PS), 'noop'));
    if ((page+1)*PS < total) nav.push(btn('➡️', 'yr_page_'+spId+'_'+(page+1)));
    rows.push(nav);
  }
  rows.push(backMenu('browse'));
  return eos(ctx, (sp?'🎓 *'+escMd(sp.name)+'*\n\n':'')+' *اختر السنة:*', { parse_mode:'Markdown', ...build(rows) });
}

async function showSemesters(ctx, spId, yrId) {
  ctx.answerCbQuery('').catch(function() {});
  spId = safeInt(spId); yrId = safeInt(yrId);
  var ckey = 'sems_'+spId+'_'+yrId;
  var sd = cacheGet(ckey);
  if (!sd) {
    var r = await Promise.all([content.getSpec(spId), content.getYear(yrId), content.getSemesters(yrId)]);
    sd = { sp:r[0], yr:r[1], sems:r[2] };
    cacheSet(ckey, sd, 21600000);
  }
  var sp=sd.sp, yr=sd.yr, sems=sd.sems;
  if (!sems.length) return eos(ctx, '📭 لا توجد فصول.', build([backMenu('yrs_'+spId)]));
  var rows = sems.map(function(s){ return [btn('📆 '+s.name, 'sm_'+spId+'_'+yrId+'_'+s.id)]; });
  rows.push(backMenu('yrs_'+spId));
  return eos(ctx, (sp?escMd(sp.name)+' › ':'')+( yr?'*'+escMd(yr.name)+'*':'')+'\n\n📆 *اختر الفصل:*', { parse_mode:'Markdown', ...build(rows) });
}

async function showSubjects(ctx, spId, yrId, smId, page) {
  ctx.answerCbQuery('').catch(function() {});
  spId=safeInt(spId); yrId=safeInt(yrId); smId=safeInt(smId); page=safeInt(page);
  var ckey = 'subs_'+spId+'_'+yrId+'_'+smId;
  var subd = cacheGet(ckey);
  if (!subd) {
    var r = await Promise.all([content.getSpec(spId), content.getYear(yrId), content.getSemester(smId), content.getSubjects(smId)]);
    subd = { sp:r[0], yr:r[1], sm:r[2], all:r[3] };
    cacheSet(ckey, subd, 21600000);
  }
  var sp=subd.sp, yr=subd.yr, sm=subd.sm, all=subd.all, total=all.length;
  var subs = all.slice(page*PS, (page+1)*PS);
  if (!subs.length) return eos(ctx, '📭 لا توجد مواد.', build([backMenu('sm_'+spId+'_'+yrId)]));
  var rows = [];
  for (var i=0; i<subs.length; i+=2) {
    var row = [btn('📖 '+subs[i].name, 'sb_'+spId+'_'+yrId+'_'+smId+'_'+subs[i].id)];
    if (subs[i+1]) row.push(btn('📖 '+subs[i+1].name, 'sb_'+spId+'_'+yrId+'_'+smId+'_'+subs[i+1].id));
    rows.push(row);
  }
  if (total > PS) {
    var nav = [];
    if (page > 0) nav.push(btn('⬅️', 'sb_page_'+spId+'_'+yrId+'_'+smId+'_'+(page-1)));
    nav.push(btn((page+1)+'/'+Math.ceil(total/PS), 'noop'));
    if ((page+1)*PS < total) nav.push(btn('➡️', 'sb_page_'+spId+'_'+yrId+'_'+smId+'_'+(page+1)));
    rows.push(nav);
  }
  rows.push(backMenu('sms_'+spId+'_'+yrId));
  return eos(ctx, (sp?escMd(sp.name)+' › ':'')+( yr?escMd(yr.name)+' › ':'')+(sm?'*'+escMd(sm.name)+'*':'')+'\n\n📖 *اختر المادة:*', { parse_mode:'Markdown', ...build(rows) });
}

async function showCategories(ctx, spId, yrId, smId, sbId) {
  ctx.answerCbQuery('').catch(function() {});
  spId=safeInt(spId); yrId=safeInt(yrId); smId=safeInt(smId); sbId=safeInt(sbId);
  var ckey = 'cats_'+spId+'_'+yrId+'_'+smId+'_'+sbId;
  var catd = cacheGet(ckey);
  if (!catd) {
    var r = await Promise.all([content.getSpec(spId), content.getYear(yrId), content.getSemester(smId), content.getSubject(sbId), content.getCategories(sbId)]);
    catd = { sp:r[0], yr:r[1], sm:r[2], sb:r[3], cats:r[4] };
    cacheSet(ckey, catd, 3600000);
  }
  var sp=catd.sp, yr=catd.yr, sm=catd.sm, sb=catd.sb, cats=catd.cats;
  if (!cats.length) return eos(ctx, '📭 لا توجد فئات.', build([backMenu('sbs_'+spId+'_'+yrId+'_'+smId)]));
  var rows = cats.map(function(c){ return [btn('📁 '+c.name, 'ct_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+c.id)]; });
  rows.push(backMenu('sbs_'+spId+'_'+yrId+'_'+smId));
  return eos(ctx, (sb?'*'+escMd(sb.name)+'*':'')+'\n\n📁 *اختر القسم:*', { parse_mode:'Markdown', ...build(rows) });
}

async function showFiles(ctx, spId, yrId, smId, sbId, catId, page) {
  spId=safeInt(spId); yrId=safeInt(yrId); smId=safeInt(smId);
  sbId=safeInt(sbId); catId=safeInt(catId); page=safeInt(page);
  var uid = ctx.uid;
  var staticKey = 'showfiles_'+catId;
  var staticData = cacheGet(staticKey);
  if (!staticData) {
    var r = await Promise.all([getPathData(spId,yrId,smId,sbId,catId), filesDb.getFiles(catId), bundlesDb.getBundles(catId)]);
    staticData = { pathData:r[0], allFiles:r[1], bundles:r[2] };
    cacheSet(staticKey, staticData, 86400000);
  }
  var pd=staticData.pathData, allFiles=staticData.allFiles, bundles=staticData.bundles;
  var sp=pd.sp, yr=pd.yr, sm=pd.sm, sb=pd.sb, cat=pd.cat;
  var total=allFiles.length, list=allFiles.slice(page*PS,(page+1)*PS);
  // 🔍 DEBUG مؤقت — يظهر القيم الفعلية عند فشل العثور على cat
  if (!cat) {
    require('../utils/logger').error('[showFiles DEBUG]',
      'spId='+spId, 'yrId='+yrId, 'smId='+smId, 'sbId='+sbId, 'catId='+catId,
      'pd.sp='+JSON.stringify(sp), 'pd.cat='+JSON.stringify(cat));
  }
  var text = (cat?'*'+escMd(cat.name)+'*\n':'⚠️ *DEBUG*: sp='+spId+' yr='+yrId+' sm='+smId+' sb='+sbId+' cat='+catId+' | cat موجود: '+(!!cat)+'\n')+'\n'+(total?'📄 *'+total+' ملف*':'لا توجد ملفات');
  var fileIds = list.map(function(f){ return f.id; });
  var favKey = 'favbatch_'+uid+'_'+catId+'_'+page;
  var favMap = cacheGet(favKey);
  if (!favMap) { favMap = await interactions.getFavBatch(uid, fileIds).catch(()=>({})); cacheSet(favKey, favMap, 300000); }
  var rows = list.map(function(f) {
    var fav = favMap[f.id]||false;
    var typeIcon = f.file_type==='link'?'🔗':f.file_type==='photo'?'🖼️':'📄';
    return [btn(typeIcon+' '+f.title, 'fl_'+f.id+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId), btn(fav?'⭐':'☆','fav_'+f.id)];
  });
  if (total > PS) {
    var nav = [];
    if (page > 0) nav.push(btn('⬅️','ct_page_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId+'_'+(page-1)));
    nav.push(btn((page+1)+'/'+Math.ceil(total/PS),'noop'));
    if ((page+1)*PS < total) nav.push(btn('➡️','ct_page_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId+'_'+(page+1)));
    rows.push(nav);
  }
  if (bundles && bundles.length) {
    rows.unshift([btn('━━━ الحزم ('+bundles.length+') ━━━','noop')]);
    bundles.forEach(function(b,i){ rows.splice(i+1,0,[btn('📦 '+b.title,'bundle_'+b.id+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)]); });
  }
  rows.push(backMenu('sb_'+spId+'_'+yrId+'_'+smId+'_'+sbId));
  return eos(ctx, text, { parse_mode:'Markdown', ...build(rows) });
}

async function showPreview(ctx, fid, spId, yrId, smId, sbId, catId) {
  fid=safeInt(fid); spId=safeInt(spId); yrId=safeInt(yrId);
  smId=safeInt(smId); sbId=safeInt(sbId); catId=safeInt(catId);
  var uid = ctx.uid;
  var staticKey = 'prev_static_'+fid;
  var personalKey = 'personal_'+uid+'_'+fid;
  var staticData = cacheGet(staticKey);
  var personalCached = cacheGet(personalKey);
  if (!staticData || !personalCached) {
    var par = await Promise.all([
      staticData ? null : Promise.all([filesDb.getFile(fid), interactions.getAvgRating(fid), commentsDb.countComments(fid), interactions.favCount(fid)]),
      personalCached ? null : interactions.getPreviewPersonal(uid, fid)
    ]);
    if (!staticData) { var res=par[0]; staticData={f:res[0],ratingData:res[1],commentCount:res[2],favCnt:res[3]}; if(res[0])cacheSet(staticKey,staticData,43200000); }
    if (!personalCached) { personalCached=par[1]; cacheSet(personalKey,personalCached,300000); }
  }
  var f=staticData.f, ratingData=staticData.ratingData, commentCount=staticData.commentCount, favCnt=staticData.favCnt;
  if (!f) return ctx.reply('❌ الملف غير موجود.').catch(function(){});
  var fav=personalCached.fav, userRating=personalCached.userRating;
  var avg=ratingData?ratingData.avg:0, cnt=ratingData?ratingData.cnt:0;
  var text = '📄 *'+escMd(f.title)+'*\n'+(f.description?'📝 _'+escMd(f.description)+'_\n':'')+'\n📁 '+escMd(f.cat_name||'')+'  |  📖 '+escMd(f.sub_name||'')+'\n⬇️ *'+f.downloads+'* تحميل  |  💬 *'+commentCount+'* تعليق\n'+(avg>0?'⭐ '+parseFloat(avg).toFixed(1)+' ('+cnt+')':'');
  var backCb = (catId && catId != '0' && catId != 0) ? 'ct_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId : 'main_menu';
  var ratingBtns = [1,2,3,4,5].map(function(i){ return btn(i<=userRating?'⭐':'☆','rate_'+fid+'_'+i+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId); });
  var rows = [
    [btn('⬇️ تحميل الملف','fl_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)],
    [btn(fav?'⭐ محفوظ':'☆ حفظ','fav_'+fid), btn('💬 تعليقات ('+commentCount+')','cmt_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)],
    ratingBtns,
    [btn('◀️ رجوع',backCb),btn('🏠','main_menu')]
  ];
  return eos(ctx, text, { parse_mode:'Markdown', ...build(rows) });
}

async function showReportMenu(ctx, fid, spId, yrId, smId, sbId, catId) {
  var reasons = [['🔗 رابط معطوب','broken_link'],['📄 ملف تالف','corrupted'],['❌ ملف خاطئ','wrong_file'],['🔄 ملف مكرر','duplicate'],['⚠️ محتوى غير لائق','inappropriate']];
  var rows = reasons.map(function(r){ return [btn(r[0],'do_report_'+fid+'_'+r[1]+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)]; });
  rows.push([btn('◀️ إلغاء','preview_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)]);
  return eos(ctx, '⚠️ *تبليغ عن مشكلة*\n\nاختر نوع المشكلة:', { parse_mode:'Markdown', ...build(rows) });
}

async function doReport(ctx, fid, reason, spId, yrId, smId, sbId, catId) {
  fid = safeInt(fid);
  var uid = ctx.uid;
  try { await reportsDb.addReport(fid, uid, reason); } catch(_){}
  await ctx.answerCbQuery('✅ تم إرسال التبليغ، شكراً!', { show_alert:true }).catch(function(){});
  return showPreview(ctx, fid, spId, yrId, smId, sbId, catId);
}

async function showComments(ctx, fid, spId, yrId, smId, sbId, catId, page) {
  fid=safeInt(fid); page=safeInt(page);
  var cmtKey = 'cmts_'+fid+'_'+page;
  var cmtCached = cacheGet(cmtKey);
  var comments, f;
  if (cmtCached) { comments=cmtCached.comments; f=cmtCached.f; }
  else { var r=await Promise.all([commentsDb.getComments(fid,50),filesDb.getFile(fid)]); comments=r[0]; f=r[1]; cacheSet(cmtKey,{comments,f},60000); }
  var CPS=5, total=comments.length, list=comments.slice(page*CPS,(page+1)*CPS);
  var text = '💬 *تعليقات: '+escMd(f?f.title:'')+'*\n━━━━━━━━━━━━\n';
  if (!list.length) { text += '_لا توجد تعليقات بعد._'; }
  else { list.forEach(function(c){ text+='\n👤 *'+escMd(c.first_name||'مجهول')+'*\n'+escMd(c.text)+'\n'; }); }
  var rows = [];
  if (ctx.isAdmin) { list.forEach(function(c){ rows.push([btn('🗑 '+c.text.substring(0,20),'dcmt_'+c.id+'_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)]); }); }
  var nav = [];
  if (page>0) nav.push(btn('⬅️','cmt_pg_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId+'_'+(page-1)));
  if ((page+1)*CPS<total) nav.push(btn('➡️','cmt_pg_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId+'_'+(page+1)));
  if (nav.length) rows.push(nav);
  rows.push([btn('✍️ أضف تعليق','add_cmt_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)]);
  rows.push([btn('◀️ رجوع','preview_'+fid+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)]);
  return eos(ctx, text, { parse_mode:'Markdown', ...build(rows) });
}

async function sendFile(ctx, fid, spId, yrId, smId, sbId, catId) {
  fid = safeInt(fid);
  var uid = ctx.uid;

  // بناء زر رجوع صحيح:
  // - إذا وصلت السلسلة كاملة (تصفح عادي): استخدمها مباشرة
  // - إذا كان catId حقيقياً لكن الباقي أصفار (من جديد/مفضلاتي/سجلي):
  //   استرجع المسار الحقيقي من category_id عبر استعلام واحد مخزَّن مؤقتاً
  // - إذا لم يوجد catId إطلاقاً: ارجع للقائمة الرئيسية
  var backCb = 'main_menu';
  var hasCat = catId && catId != '0' && catId != 0;
  if (hasCat) {
    var hasFullPath = spId && spId != '0' && spId != 0;
    if (hasFullPath) {
      backCb = 'ct_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId;
    } else {
      var realPath = await content.getPathFromCategory(catId).catch(function(){ return null; });
      require('../utils/logger').debug('[backCb] catId='+catId+' realPath='+JSON.stringify(realPath));
      if (realPath && realPath.spId) {
        backCb = 'ct_'+realPath.spId+'_'+realPath.yrId+'_'+realPath.smId+'_'+realPath.sbId+'_'+catId;
        require('../utils/logger').debug('[backCb] built backCb='+backCb);
        // أبطل أي كاش قديم لهذا المسار (قد يكون بُني سابقاً بمعرّفات أصفار خاطئة)
        cacheClear('showfiles_'+catId);
        cacheClear('path_'+realPath.spId+'_'+realPath.yrId+'_'+realPath.smId+'_'+realPath.sbId+'_'+catId);
      } else {
        require('../utils/logger').debug('[backCb] realPath invalid, backCb stays main_menu');
      }
    }
  }

  // ⚡ 1. رد فوري — يشيل الـ spinner قبل أي شيء
  ctx.answerCbQuery('📥 جاري التحميل...').catch(function(){});

  // ⚡ 2. جلب البيانات + sendChatAction بالتوازي — بدون انتظار
  var _fkey = 'file_'+fid;
  var _fcached = cacheGet(_fkey);
  var [results] = await Promise.all([
    Promise.all([
      _fcached ? Promise.resolve(_fcached) : filesDb.getFile(fid).then(function(f){ if(f)cacheSet(_fkey,f,1800000); return f; }),
      interactions.isFav(uid, fid).catch(function(){ return false; })
    ]),
    ctx.sendChatAction('upload_document').catch(function(){}),
  ]);
  var f=results[0], fav=results[1];
  if (!f) return ctx.reply('❌ الملف غير موجود.').catch(function(){});

  // ⚡ 3. عدّل الرسالة الحالية (قائمة الملفات) لمؤشر ⏳ بدل حذفها فوراً — نفس
  // طريقة eos() المستخدمة بباقي شاشات هذا الملف (showSpecialties/showYears/...).
  // كذا الرسالة تتحول مباشرة لـ"جاري الإرسال" بدل ما تختفي وتسيب فراغ لين
  // يوصل الملف (هذا اللي كان يحس المستخدم فيه كـ"ثقل"/بلاغ مفاجئ).
  await eos(ctx, '⏳', {});

  var caption = '📄 *'+escMd(f.title)+'*\n'+(f.description?'📝 '+escMd(f.description)+'\n':'')+'📁 '+escMd(f.cat_name||'عام')+'  |  📖 '+escMd(f.sub_name||'عام');
  var kb = build([[btn(fav?'⭐ محفوظ':'☆ حفظ','fav_'+fid)],[btn('◀️ رجوع',backCb),btn('🏠','main_menu')]]);

  var sendP;
  if      (f.file_type==='link')  sendP = ctx.reply(caption+'\n\n🔗 '+f.file_id, { parse_mode:'Markdown', ...kb });
  else if (f.file_type==='photo') sendP = ctx.replyWithPhoto(f.file_id, { caption, parse_mode:'Markdown', ...kb });
  else if (f.file_type==='video') sendP = ctx.replyWithVideo(f.file_id, { caption, parse_mode:'Markdown', ...kb });
  else if (f.file_type==='audio') sendP = ctx.replyWithAudio(f.file_id, { caption, parse_mode:'Markdown', ...kb });
  else                             sendP = ctx.replyWithDocument(f.file_id, { caption, parse_mode:'Markdown', ...kb });

  // ⚡ 4. بعد نجاح الإرسال فقط احذف رسالة "⏳" — القديمة توصل تختفي بالضبط وقت
  // ما يوصل الملف، مو قبله. لو فشل الإرسال، عدّل نفس الرسالة لخطأ بدل ما تعلق بـ⏳
  try {
    await sendP;
    ctx.deleteMessage().catch(function(){});
  } catch (e) {
    ctx.editMessageText('❌ تعذر إرسال الملف.', { parse_mode:'Markdown' }).catch(function(){
      ctx.reply('❌ تعذر إرسال الملف.').catch(function(){});
    });
  }

  // ⚡ 5. عمليات الخلفية — لا تأخر المستخدم أبداً
  filesDb.incDownloads(fid);
  interactions.addHistory(uid, fid).catch(function(){});
  try { require('../database/points').awardPoints(uid, 'download').catch(()=>{}); } catch(_) {}
  _showSimilar(ctx, f, spId, yrId, smId, sbId, catId).catch(function(){});
}

async function _showSimilar(ctx, f, spId, yrId, smId, sbId, catId) {
  if (!catId || catId === 0) catId = f.category_id;
  if (!catId) return;
  const simKey = 'similar_' + f.id + '_' + catId;
  let similar = cacheGet(simKey);
  if (!similar) {
    // ابحث في نفس القسم أولاً
    similar = await all(
      'SELECT f.id, f.title, f.file_type FROM files f WHERE f.category_id=$1 AND f.id!=$2 AND f.is_deleted=0 ORDER BY f.downloads DESC LIMIT 4',
      [catId, f.id]
    ).catch(() => []);
    // إذا ما في نتائج — ابحث في نفس المادة
    if (!similar.length) {
      similar = await all(
        'SELECT f.id, f.title, f.file_type FROM files f JOIN categories c ON f.category_id=c.id WHERE c.subject_id=(SELECT subject_id FROM categories WHERE id=$1) AND f.id!=$2 AND f.is_deleted=0 ORDER BY f.downloads DESC LIMIT 4',
        [catId, f.id]
      ).catch(() => []);
    }
    if (similar.length) cacheSet(simKey, similar, 600000);
  }
  if (!similar || !similar.length) return;

  const rows = similar.map(s => {
    const icon = s.file_type === 'photo' ? '🖼' : s.file_type === 'link' ? '🔗' : '📄';
    return [btn(icon + ' ' + s.title.substring(0, 35), 'fl_' + s.id + '_' + spId + '_' + yrId + '_' + smId + '_' + sbId + '_' + catId)];
  });
  rows.push([btn('◀️ رجوع', 'ct_' + spId + '_' + yrId + '_' + smId + '_' + sbId + '_' + catId), btn('🏠', 'main_menu')]);

  await ctx.reply('📚 من نفس القسم:', {
    parse_mode: 'Markdown',
    ...build(rows)
  }).catch(() => {});
}

async function showBundle(ctx, bundleId, spId, yrId, smId, sbId, catId) {
  bundleId = safeInt(bundleId);
  var bkey='bundle_full_'+bundleId, bcached=cacheGet(bkey), b, files;
  if (bcached) { b=bcached.b; files=bcached.files; }
  else { var r=await Promise.all([bundlesDb.getBundle(bundleId),bundlesDb.getBundleFiles(bundleId)]); b=r[0]; files=r[1]; if(b)cacheSet(bkey,{b,files},600000); }
  if (!b) return ctx.reply('الحزمة غير موجودة');
  var text = '📦 *'+escMd(b.title)+'*'+(b.description?'\n📝 '+escMd(b.description):'')+'\n\n📁 *'+files.length+' ملف* | ⬇️ '+b.downloads+' تحميل';
  var backCb = catId!==0?'ct_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId:'main_menu';
  var rows = [[btn('⬇️ تحميل الكل','bdl_'+bundleId+'_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId)],[btn('◀️ رجوع',backCb)]];
  return eos(ctx, text, { parse_mode:'Markdown', ...build(rows) });
}

async function sendBundle(ctx, bundleId, spId, yrId, smId, sbId, catId) {
  bundleId = safeInt(bundleId);
  var bkey='bundle_full_'+bundleId, bcached=cacheGet(bkey), b, files;
  if (bcached) { b=bcached.b; files=bcached.files; }
  else { var r=await Promise.all([bundlesDb.getBundle(bundleId),bundlesDb.getBundleFiles(bundleId)]); b=r[0]; files=r[1]; if(b)cacheSet(bkey,{b,files},600000); }
  if (!files||!files.length) return ctx.reply('الحزمة فارغة');
  bundlesDb.incBundleDownloads(bundleId).catch(function(){});
  await ctx.reply('📦 *'+escMd(b.title)+'* — جاري الإرسال...', { parse_mode:'Markdown' });
  var photos=files.filter(function(f){return f.real_type==='photo';}),
      docs=files.filter(function(f){return f.real_type==='document';}),
      videos=files.filter(function(f){return f.real_type==='video';}),
      audios=files.filter(function(f){return f.real_type==='audio'||f.real_type==='voice';}),
      links=files.filter(function(f){return f.real_type==='link';});
  if (photos.length) {
    try { await ctx.replyWithMediaGroup(photos.map(function(f){return{type:'photo',media:f.file_id,caption:f.file_title||f.title||''};})); }
    catch(e) { for(var i=0;i<photos.length;i++) await ctx.replyWithPhoto(photos[i].file_id,{caption:photos[i].file_title||''}).catch(function(){}); }
  }
  if(videos.length) await Promise.all(videos.map(function(f){return ctx.replyWithVideo(f.file_id,{caption:f.file_title||''}).catch(function(){});}));
  if(docs.length) await Promise.all(docs.map(function(f){return ctx.replyWithDocument(f.file_id,{caption:f.file_title||''}).catch(function(){});}));
  for(var i=0;i<audios.length;i++) {
    if(audios[i].real_type==='voice') await ctx.replyWithVoice(audios[i].file_id).catch(function(){});
    else await ctx.replyWithAudio(audios[i].file_id,{caption:audios[i].file_title||''}).catch(function(){});
  }
  if (links.length) {
    var linkMsg='🔗 *الروابط:*\n\n';
    links.forEach(function(l,i){linkMsg+=(i+1)+'. '+(l.file_title||l.title||'')+'\n'+l.file_id+'\n\n';});
    await ctx.reply(linkMsg,{parse_mode:'Markdown'});
  }
  var backCb=catId!==0?'ct_'+spId+'_'+yrId+'_'+smId+'_'+sbId+'_'+catId:'main_menu';
  await ctx.reply('✅ اكتمل الإرسال!', {...build([[btn('◀️ رجوع',backCb),btn('🏠','main_menu')]])});
}

module.exports = { _showSimilar, showSpecs, showYears, showSemesters, showSubjects, showCategories, showFiles, showPreview, showReportMenu, doReport, showComments, sendFile, showBundle, sendBundle };
