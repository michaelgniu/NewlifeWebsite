/**
 * 新生命教会 · 关怀探访系统
 * 平台：Google 表格（数据库） + Apps Script（自动调度 + Gmail 通知）
 *
 * 首次安装步骤见 README.md。核心：
 *   1) 运行 setupSheet()   —— 创建/初始化所有工作表
 *   2) 部署为「网页应用」   —— 用于同工反馈链接
 *   3) 运行 installTriggers() —— 安装定时触发器
 */

// ─────────────────────────────────────────────────────────────
// 工作表 & 列定义（改动列顺序时同步这里）
// ─────────────────────────────────────────────────────────────
const SHEETS = {
  VISITORS:  '访客',
  FOLLOWUPS: '跟进记录',
  VOLUNTEERS:'同工',
  GROUPS:    '小组',
  CONFIG:    '设置'
};

// 访客表列号（1-based）
const V = {
  ID:1, NAME:2, PHONE:3, EMAIL:4, AREA:5, IDENTITY:6, FIRST_VISIT:7,
  VISIT_COUNT:8, STATUS:9, ASSIGNEE:10, ASSIGNEE_EMAIL:11, ASSIGN_DATE:12,
  LAST_RESULT:13, LAST_CONTACT_DATE:14, ESCALATED:15, NOTE:16
};

// 访客状态取值
const ST = {
  UNASSIGNED:'待分配', FOLLOWING:'跟进中', CONTACTED:'已联系',
  GROUPED:'已安排小组', GOSPEL:'福音群', LOST:'失联'
};

const HEADERS = {
  '访客': ['访客ID','姓名','电话','邮箱','居住区域','身份（基督徒/慕道友/未知）',
           '首次来访日期','来访次数','当前状态','分配同工','分配同工邮箱','分配日期',
           '末次联系结果','末次联系日期','升级通知已发','备注'],
  '跟进记录': ['时间戳','访客ID','访客姓名','同工','联系结果','是否鼓励再来','备注'],
  '同工': ['姓名','邮箱','电话','负责区域','角色（同工/负责人）','启用（TRUE/FALSE）'],
  '小组': ['组名','覆盖区域','负责人姓名','负责人邮箱','聚会时间'],
  '设置': ['键','值']
};

const CONFIG_DEFAULTS = [
  ['教会名称', '新生命国语播道会'],
  ['探访负责人邮箱', 'REPLACE_ME@example.com'],
  ['福音事工负责人邮箱', 'REPLACE_ME@example.com'],
  ['来访达标次数', '4'],
  ['失联周数', '4']
];

// ─────────────────────────────────────────────────────────────
// 一次性初始化
// ─────────────────────────────────────────────────────────────
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const hdr = HEADERS[name];
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  // 写入默认设置（仅当为空时）
  const cfg = ss.getSheetByName(SHEETS.CONFIG);
  if (cfg.getLastRow() < 2) {
    cfg.getRange(2, 1, CONFIG_DEFAULTS.length, 2).setValues(CONFIG_DEFAULTS);
  }
  // 删除默认的空 Sheet1
  const s1 = ss.getSheetByName('Sheet1') || ss.getSheetByName('工作表1');
  if (s1 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  SpreadsheetApp.getUi().alert('初始化完成！请到「设置」「同工」「小组」表填写内容。');
}

// ─────────────────────────────────────────────────────────────
// 辅助函数
// ─────────────────────────────────────────────────────────────
function sheet_(name){ return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name); }

function getConfig_(key){
  const rows = sheet_(SHEETS.CONFIG).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) if (rows[i][0] === key) return rows[i][1];
  return '';
}

function visitorRows_(){
  const sh = sheet_(SHEETS.VISITORS);
  const last = sh.getLastRow();
  if (last < 2) return { sh, rows: [] };
  const rows = sh.getRange(2, 1, last - 1, HEADERS['访客'].length).getValues();
  return { sh, rows };
}

function activeVolunteers_(){
  const rows = sheet_(SHEETS.VOLUNTEERS).getDataRange().getValues();
  const out = [];
  for (let i = 1; i < rows.length; i++){
    const [name,email,phone,area,role,enabled] = rows[i];
    if (name && email && String(enabled).toUpperCase() !== 'FALSE')
      out.push({ name, email, area:String(area||''), role:String(role||'') });
  }
  return out;
}

function webAppUrl_(){
  try { return ScriptApp.getService().getUrl() || ''; } catch(e){ return ''; }
}

function daysBetween_(a, b){ return Math.floor((b - a) / (1000*60*60*24)); }

// ─────────────────────────────────────────────────────────────
// 步骤2（周三）：给待分配访客分配同工并发提醒
// ─────────────────────────────────────────────────────────────
function assignNewVisitors(){
  const { sh, rows } = visitorRows_();
  const vols = activeVolunteers_();
  if (!vols.length){ console.log('没有可用同工'); return; }
  const callers = vols.filter(v => v.role.indexOf('同工') >= 0 || v.role.indexOf('负责人') >= 0);
  const pool = callers.length ? callers : vols;
  const church = getConfig_('教会名称');
  const url = webAppUrl_();
  let ptr = Number(PropertiesService.getScriptProperties().getProperty('RR') || 0);

  rows.forEach((r, i) => {
    if (String(r[V.STATUS-1]).trim() !== ST.UNASSIGNED) return;
    const area = String(r[V.AREA-1] || '');
    // 优先按区域匹配同工，否则轮流
    let vol = pool.find(v => v.area && area && (area.indexOf(v.area) >= 0 || v.area.indexOf(area) >= 0));
    if (!vol){ vol = pool[ptr % pool.length]; ptr++; }

    const row = i + 2;
    // 若忘填访客ID，自动补一个唯一ID（反馈链接依赖它）
    if (!String(r[V.ID-1] || '').trim()){
      const newId = 'V' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMddHHmmss') + row;
      sh.getRange(row, V.ID).setValue(newId);
      r[V.ID-1] = newId;
    }
    sh.getRange(row, V.ASSIGNEE).setValue(vol.name);
    sh.getRange(row, V.ASSIGNEE_EMAIL).setValue(vol.email);
    sh.getRange(row, V.ASSIGN_DATE).setValue(new Date());
    sh.getRange(row, V.STATUS).setValue(ST.FOLLOWING);
    sh.getRange(row, V.ESCALATED).setValue(false);

    const name = r[V.NAME-1], phone = r[V.PHONE-1];
    const link = url ? (url + '?id=' + encodeURIComponent(r[V.ID-1])) : '（网页应用未部署）';
    const subject = `【关怀探访】本周请致电欢迎新朋友：${name}`;
    const body =
`亲爱的 ${vol.name} 弟兄姊妹，平安！

本周分配给您一位新朋友，请在本周三或周四致电，再次欢迎他/她，并鼓励再来教会：

  姓名：${name}
  电话：${phone}
  身份：${r[V.IDENTITY-1] || '未知'}
  居住区域：${area || '（未填）'}
  首次来访：${fmtDate_(r[V.FIRST_VISIT-1])}
  备注：${r[V.NOTE-1] || '无'}

联系后请点此填写反馈（很重要，否则周五会再次提醒并通知负责人）：
${link}

愿主使用您成为祝福！
${church} · 关怀探访系统`;
    MailApp.sendEmail(vol.email, subject, body);
  });

  PropertiesService.getScriptProperties().setProperty('RR', String(ptr));
}

// ─────────────────────────────────────────────────────────────
// 步骤3（周五）：未跟进的二次提醒 + 通知负责人
// ─────────────────────────────────────────────────────────────
function escalateUnfollowed(){
  const { sh, rows } = visitorRows_();
  const leaderEmail = getConfig_('探访负责人邮箱');
  const church = getConfig_('教会名称');
  const url = webAppUrl_();

  rows.forEach((r, i) => {
    if (String(r[V.STATUS-1]).trim() !== ST.FOLLOWING) return;
    if (String(r[V.ESCALATED-1]).toUpperCase() === 'TRUE') return; // 已升级过

    const assignDate = r[V.ASSIGN_DATE-1];
    const lastContact = r[V.LAST_CONTACT_DATE-1];
    const contacted = lastContact && assignDate && (new Date(lastContact) >= new Date(assignDate));
    if (contacted) return; // 本轮已联系，无需升级

    const row = i + 2;
    const name = r[V.NAME-1], phone = r[V.PHONE-1];
    const link = url ? (url + '?id=' + encodeURIComponent(r[V.ID-1])) : '';

    // 二次提醒同工
    if (r[V.ASSIGNEE_EMAIL-1]){
      MailApp.sendEmail(r[V.ASSIGNEE_EMAIL-1],
        `【再次提醒】新朋友 ${name} 尚未跟进`,
`${r[V.ASSIGNEE-1]} 平安！

本周分配给您的新朋友 ${name}（电话 ${phone}）系统里还没有您的联系反馈。
若已联系，请补填反馈：${link}
若本周未能联系，负责人将接手跟进。

${church} · 关怀探访系统`);
    }
    // 通知负责人
    if (leaderEmail){
      MailApp.sendEmail(leaderEmail,
        `【需接手】${name} 本周未被跟进`,
`负责人您好：

新朋友 ${name}（电话 ${phone}，区域 ${r[V.AREA-1]||'未填'}）本周分配给 ${r[V.ASSIGNEE-1]||'（未分配）'}，
但截至周五仍无联系反馈。请您进一步跟踪，或亲自联系。

反馈填写：${link}

${church} · 关怀探访系统`);
    }
    sh.getRange(row, V.ESCALATED).setValue(true);
  });
}

// ─────────────────────────────────────────────────────────────
// 每日：来访达标（默认4次）安排小组/福音群；超期未联系转失联
// ─────────────────────────────────────────────────────────────
function dailyChecks(){
  checkMilestones_();
  checkLostContact_();
}

function checkMilestones_(){
  const { sh, rows } = visitorRows_();
  const goal = Number(getConfig_('来访达标次数') || 4);
  const gospelLeader = getConfig_('福音事工负责人邮箱');
  const careLeader = getConfig_('探访负责人邮箱');
  const church = getConfig_('教会名称');
  const groups = sheet_(SHEETS.GROUPS).getDataRange().getValues();

  rows.forEach((r, i) => {
    const status = String(r[V.STATUS-1]).trim();
    if ([ST.GROUPED, ST.GOSPEL, ST.LOST].indexOf(status) >= 0) return;
    if (Number(r[V.VISIT_COUNT-1] || 0) < goal) return;

    const row = i + 2, name = r[V.NAME-1];
    const identity = String(r[V.IDENTITY-1] || '');
    const area = String(r[V.AREA-1] || '');

    if (identity.indexOf('基督徒') >= 0){
      // 就近匹配小组
      let match = null;
      for (let g = 1; g < groups.length; g++){
        const [gname, cover, leaderName, leaderEmail] = groups[g];
        if (cover && area && (String(cover).indexOf(area) >= 0 || area.indexOf(String(cover)) >= 0)){
          match = { gname, leaderName, leaderEmail }; break;
        }
      }
      if (match && match.leaderEmail){
        MailApp.sendEmail(match.leaderEmail,
          `【新组员】请接纳 ${name} 加入${match.gname}`,
`${match.leaderName} 平安！

新朋友 ${name}（电话 ${r[V.PHONE-1]}，区域 ${area}）已来教会 ${r[V.VISIT_COUNT-1]} 次，是基督徒，
按居住区域就近安排加入您带领的「${match.gname}」。请与他/她联系，欢迎加入小组。

${church} · 关怀探访系统`);
        sh.getRange(row, V.STATUS).setValue(ST.GROUPED);
      } else {
        // 无对口小组，交负责人手动安排
        if (careLeader) MailApp.sendEmail(careLeader,
          `【待手动安排小组】${name}`,
`新朋友 ${name}（区域 ${area||'未填'}）已达 ${r[V.VISIT_COUNT-1]} 次来访、是基督徒，
但没有匹配到对口小组，请手动安排合适的小组。\n\n${church} · 关怀探访系统`);
        sh.getRange(row, V.STATUS).setValue(ST.GROUPED);
      }
    } else if (identity.indexOf('慕道') >= 0){
      if (gospelLeader) MailApp.sendEmail(gospelLeader,
        `【福音跟进】请接纳慕道友 ${name}`,
`福音事工负责人您好：

慕道友 ${name}（电话 ${r[V.PHONE-1]}，区域 ${area||'未填'}）已来教会 ${r[V.VISIT_COUNT-1]} 次，
请加入福音聚会群并进一步跟踪。

${church} · 关怀探访系统`);
      sh.getRange(row, V.STATUS).setValue(ST.GOSPEL);
    } else {
      // 身份未知，通知负责人确认
      if (careLeader) MailApp.sendEmail(careLeader,
        `【请确认身份】${name} 已达标`,
`新朋友 ${name} 已来 ${r[V.VISIT_COUNT-1]} 次，但身份为「未知」，请确认是基督徒还是慕道友后再安排。
\n${church} · 关怀探访系统`);
    }
  });
}

function checkLostContact_(){
  const { sh, rows } = visitorRows_();
  const weeks = Number(getConfig_('失联周数') || 4);
  const leader = getConfig_('探访负责人邮箱');
  const church = getConfig_('教会名称');
  const now = new Date();

  rows.forEach((r, i) => {
    const status = String(r[V.STATUS-1]).trim();
    if ([ST.LOST, ST.GROUPED, ST.GOSPEL].indexOf(status) >= 0) return;
    const firstVisit = r[V.FIRST_VISIT-1];
    if (!firstVisit) return;
    if (daysBetween_(new Date(firstVisit), now) < weeks * 7) return;
    // 从未成功联系
    if (String(r[V.LAST_RESULT-1]).indexOf('已联系') >= 0) return;

    const row = i + 2;
    sh.getRange(row, V.STATUS).setValue(ST.LOST);
    if (leader) MailApp.sendEmail(leader,
      `【转入失联】${r[V.NAME-1]}`,
`新朋友 ${r[V.NAME-1]}（电话 ${r[V.PHONE-1]}）首次来访已满 ${weeks} 周仍未能成功联系，
系统已将其移入「失联名单」，不再自动联系。\n\n${church} · 关怀探访系统`);
  });
}

// ─────────────────────────────────────────────────────────────
// 同工反馈：网页应用
// ─────────────────────────────────────────────────────────────
function doGet(e){
  const id = (e && e.parameter && e.parameter.id) || '';
  const t = HtmlService.createTemplateFromFile('Feedback');
  t.visitorId = id;
  t.visitorName = lookupVisitorName_(id);
  return t.evaluate().setTitle('探访反馈').addMetaTag('viewport','width=device-width, initial-scale=1');
}

function lookupVisitorName_(id){
  if (!id) return '';
  const { rows } = visitorRows_();
  const hit = rows.find(r => String(r[V.ID-1]) === String(id));
  return hit ? hit[V.NAME-1] : '';
}

/** 由反馈网页调用（google.script.run） */
function submitFollowup(payload){
  const id = String(payload.visitorId || '');
  const result = String(payload.result || '');       // 已联系 / 未接 / 联系不上
  const encouraged = payload.encouraged ? '是' : '否';
  const note = String(payload.note || '');
  const { sh, rows } = visitorRows_();
  const idx = rows.findIndex(r => String(r[V.ID-1]) === id);
  if (idx < 0) throw new Error('找不到该访客');

  const row = idx + 2;
  const name = rows[idx][V.NAME-1];
  const who = rows[idx][V.ASSIGNEE-1] || '';

  // 写跟进记录
  sheet_(SHEETS.FOLLOWUPS).appendRow([new Date(), id, name, who, result, encouraged, note]);
  // 更新访客
  sh.getRange(row, V.LAST_RESULT).setValue(result);
  sh.getRange(row, V.LAST_CONTACT_DATE).setValue(new Date());
  if (result.indexOf('已联系') >= 0 &&
      String(rows[idx][V.STATUS-1]).trim() === ST.FOLLOWING){
    sh.getRange(row, V.STATUS).setValue(ST.CONTACTED);
  }
  return '已记录，感谢您的服事！';
}

function fmtDate_(d){
  if (!d) return '';
  if (Object.prototype.toString.call(d) === '[object Date]')
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(d);
}

// ─────────────────────────────────────────────────────────────
// 安装定时触发器（运行一次）
// ─────────────────────────────────────────────────────────────
function installTriggers(){
  // 先清除本脚本已有触发器，避免重复
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('assignNewVisitors').timeBased()
    .onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(9).create();
  ScriptApp.newTrigger('escalateUnfollowed').timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(9).create();
  ScriptApp.newTrigger('dailyChecks').timeBased()
    .everyDays(1).atHour(8).create();

  SpreadsheetApp.getUi().alert('定时触发器已安装：周三9点分配、周五9点升级、每日8点检查。');
}
