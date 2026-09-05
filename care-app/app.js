// ============================================================
// 关怀探访系统 · 前端逻辑（Supabase）
// ============================================================
const cfg = window.CARE_CONFIG;
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON);

let ME = null;          // 当前用户 profile {id,name,role,...}
let PROFILES = [];      // 所有同工（负责人/管理员可见）
let signupMode = false;

const $ = id => document.getElementById(id);
const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ROLE_LABEL = {admin:'管理员', leader:'负责人', volunteer:'同工'};

// ---------- 认证 ----------
function toggleAuth(){
  signupMode = !signupMode;
  $('name-wrap').style.display = signupMode ? 'block' : 'none';
  $('auth-btn').textContent = signupMode ? '注册' : '登录';
  $('toggle-auth').textContent = signupMode ? '已有账号？登录' : '还没有账号？注册';
  $('auth-msg').textContent = '';
}

async function doAuth(){
  const email = $('email').value.trim(), pw = $('pw').value;
  const msg = $('auth-msg'); msg.className='msg'; msg.textContent='';
  if (!email || !pw){ msg.className='msg err'; msg.textContent='请输入邮箱和密码'; return; }
  $('auth-btn').disabled = true;
  try {
    if (signupMode){
      const name = $('rname').value.trim();
      const { error } = await sb.auth.signUp({ email, password: pw, options:{ data:{ name } } });
      if (error) throw error;
      msg.className='msg ok'; msg.textContent='注册成功！若开启了邮箱验证，请查收邮件后再登录。';
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
    }
  } catch(e){ msg.className='msg err'; msg.textContent = translateErr(e.message); }
  $('auth-btn').disabled = false;
}

async function doLogout(){ await sb.auth.signOut(); location.reload(); }

function translateErr(m){
  if (/Invalid login/i.test(m)) return '邮箱或密码错误';
  if (/already registered/i.test(m)) return '该邮箱已注册，请直接登录';
  if (/at least 6/i.test(m)) return '密码至少 6 位';
  return m;
}

// ---------- 启动 ----------
sb.auth.onAuthStateChange((_e, session) => { if (session) boot(); });
(async () => {
  const { data:{ session } } = await sb.auth.getSession();
  if (session) boot();
})();

async function boot(){
  const { data:{ user } } = await sb.auth.getUser();
  if (!user) return;
  let { data: prof } = await sb.from('profiles').select('*').eq('id', user.id).single();
  if (!prof){ // 兜底：触发器若未建档
    await sb.from('profiles').insert({ id:user.id, email:user.email, name:user.email.split('@')[0] });
    ({ data: prof } = await sb.from('profiles').select('*').eq('id', user.id).single());
  }
  ME = prof;
  // 未批准的用户：显示等待批准页，不能进入应用
  if (!ME.approved && ME.role !== 'admin'){
    $('login-view').style.display='none';
    $('app-view').style.display='none';
    $('pending-who').textContent = ME.name || ME.email;
    $('pending-view').style.display='flex';
    return;
  }
  $('login-view').style.display='none';
  $('pending-view').style.display='none';
  $('app-view').style.display='block';
  $('who').innerHTML = `${esc(ME.name||ME.email)} <span class="rolechip">${ROLE_LABEL[ME.role]}</span>`;
  buildTabs();
  if (isLeader()) await loadProfiles();
  renderActive();
}

const isLeader = () => ME && (ME.role==='leader' || ME.role==='admin');
const isAdmin  = () => ME && ME.role==='admin';

// ---------- 标签页 ----------
function buildTabs(){
  const tabs = [{id:'todo',label:'我的待办'}];
  if (isLeader()) tabs.push({id:'board',label:'探访看板'},{id:'register',label:'登记新朋友'});
  if (isAdmin())  tabs.push({id:'users',label:'用户管理'},{id:'groups',label:'小组管理'});
  const nav = $('tabs'); nav.innerHTML='';
  tabs.forEach((t,i) => {
    const b = document.createElement('button');
    b.textContent = t.label; b.dataset.p = t.id;
    b.onclick = () => selectTab(t.id);
    nav.appendChild(b);
  });
  selectTab(tabs[0].id);
}
let activeTab = 'todo';
function selectTab(id){
  activeTab = id;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.p===id));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  $('p-'+id).classList.add('active');
  renderActive();
}
function renderActive(){
  if (activeTab==='todo') loadTodo();
  else if (activeTab==='board') loadBoard();
  else if (activeTab==='register') fillAssigneeSelect();
  else if (activeTab==='users') loadUsers();
  else if (activeTab==='groups') loadGroups();
}

// ---------- 数据加载 ----------
async function loadProfiles(){
  const { data } = await sb.from('profiles').select('*').order('role');
  PROFILES = data || [];
}
function nameOf(id){ const p = PROFILES.find(x=>x.id===id); return p ? (p.name||p.email) : '—'; }

async function fetchVisitors(filter){
  let q = sb.from('visitors').select('*').order('first_visit',{ascending:false});
  if (filter==='mine') q = q.eq('assignee_id', ME.id);
  const { data, error } = await q;
  if (error){ console.error(error); return []; }
  return data || [];
}

// ---------- 我的待办 ----------
async function loadTodo(){
  const list = await fetchVisitors('mine');
  const active = list.filter(v => ['待分配','跟进中','已联系'].includes(v.status));
  const el = $('todo-list');
  if (!active.length){ el.innerHTML = '<p class="muted">暂无分配给你的待办。</p>'; return; }
  el.innerHTML = active.map(v => vcard(v, true)).join('');
}

// ---------- 看板 ----------
async function loadBoard(){
  const list = await fetchVisitors('all');
  const cols = ['待分配','跟进中','已联系','已安排小组','福音群','失联'];
  const el = $('board');
  el.innerHTML = cols.map(c => {
    const items = list.filter(v => v.status===c);
    if (!items.length) return '';
    return `<div class="col-head">${c}（${items.length}）</div>` + items.map(v => vcard(v, false)).join('');
  }).join('') || '<p class="muted">还没有访客记录，去「登记新朋友」添加。</p>';
}

// ---------- 访客卡片 ----------
function vcard(v, mine){
  const assignee = v.assignee_id ? nameOf(v.assignee_id) : '未分配';
  const canEdit = isLeader() || v.assignee_id===ME.id;
  let acts = '';
  if (canEdit && v.status!=='失联'){
    acts += `<button class="btn btn-sm" onclick="openFeedback(${v.id},'${esc(v.name)}')">填反馈</button>`;
    acts += `<button class="btn btn-sm btn-ghost" onclick="incVisit(${v.id})">+1 来访</button>`;
  }
  if (isLeader()){
    acts += `<button class="btn btn-sm btn-ghost" onclick="assignPrompt(${v.id})">分配同工</button>`;
    acts += `<button class="btn btn-sm btn-ghost" onclick="statusPrompt(${v.id})">改状态</button>`;
  }
  return `<div class="card vcard">
    <div class="vh"><span class="vn">${esc(v.name)}</span>
      <span class="badge b-${v.status}">${v.status}</span></div>
    <div class="meta">📞 ${esc(v.phone)||'—'} ｜ ${esc(v.identity)} ｜ 区域：${esc(v.area)||'—'} ｜ 来访 ${v.visit_count} 次</div>
    <div class="meta">首访：${esc(v.first_visit)||'—'} ｜ 同工：${esc(assignee)}${v.last_result ? (' ｜ 末次：'+esc(v.last_result)) : ''}</div>
    ${v.note?`<div class="meta muted">备注：${esc(v.note)}</div>`:''}
    <div class="actions">${acts}</div>
  </div>`;
}

// ---------- 登记 ----------
function fillAssigneeSelect(){
  const sel = $('f-assignee'); if (!sel) return;
  sel.innerHTML = '<option value="">（自动/稍后分配）</option>' +
    PROFILES.filter(p=>p.active!==false).map(p=>`<option value="${p.id}">${esc(p.name||p.email)}（${ROLE_LABEL[p.role]}）</option>`).join('');
}

async function registerVisitor(){
  const msg = $('reg-msg'); msg.className='msg'; msg.textContent='';
  const name = $('f-name').value.trim();
  if (!name){ msg.className='msg err'; msg.textContent='请填写姓名'; return; }
  const assignee = $('f-assignee').value || null;
  const rec = {
    name, phone:$('f-phone').value.trim(), email:$('f-email').value.trim(),
    area:$('f-area').value.trim(), identity:$('f-identity').value,
    first_visit: $('f-first').value || new Date().toISOString().slice(0,10),
    visit_count: parseInt($('f-count').value||'1',10),
    note:$('f-note').value.trim(), created_by: ME.id,
    assignee_id: assignee,
    status: assignee ? '跟进中' : '待分配',
    assign_date: assignee ? new Date().toISOString() : null
  };
  const { error } = await sb.from('visitors').insert(rec);
  if (error){ msg.className='msg err'; msg.textContent='登记失败：'+error.message; return; }
  msg.className='msg ok'; msg.textContent='已登记！';
  ['f-name','f-phone','f-email','f-area','f-note'].forEach(id=>$(id).value='');
  $('f-count').value='1';
}

// ---------- 操作 ----------
async function incVisit(id){
  const { data:v } = await sb.from('visitors').select('visit_count').eq('id',id).single();
  await sb.from('visitors').update({ visit_count:(v.visit_count||0)+1 }).eq('id',id);
  renderActive();
}

async function assignPrompt(id){
  const opts = PROFILES.filter(p=>p.active!==false).map((p,i)=>`${i+1}. ${p.name||p.email}`).join('\n');
  const n = prompt('分配给哪位同工？输入序号：\n'+opts);
  if (!n) return;
  const p = PROFILES.filter(x=>x.active!==false)[parseInt(n,10)-1];
  if (!p) return;
  await sb.from('visitors').update({ assignee_id:p.id, status:'跟进中', assign_date:new Date().toISOString(), escalated:false }).eq('id',id);
  renderActive();
}

async function statusPrompt(id){
  const s = prompt('改为哪个状态？\n待分配 / 跟进中 / 已联系 / 已安排小组 / 福音群 / 失联');
  const ok = ['待分配','跟进中','已联系','已安排小组','福音群','失联'];
  if (!ok.includes(s)) return;
  await sb.from('visitors').update({ status:s }).eq('id',id);
  renderActive();
}

// ---------- 反馈弹窗 ----------
let fbVisitor = null;
function openFeedback(id, name){
  fbVisitor = id;
  $('m-title').textContent = '探访反馈 · ' + name;
  $('m-note').value=''; $('m-enc').checked=true; $('mr1').checked=true;
  $('m-msg').textContent='';
  $('modal').classList.add('open');
}
function closeModal(){ $('modal').classList.remove('open'); }
async function submitFeedback(){
  const result = document.querySelector('input[name=mresult]:checked').value;
  const encouraged = $('m-enc').checked;
  const note = $('m-note').value.trim();
  const { error:e1 } = await sb.from('followups').insert({
    visitor_id: fbVisitor, by_id: ME.id, by_name: ME.name||ME.email,
    result, encouraged, note
  });
  if (e1){ $('m-msg').className='msg err'; $('m-msg').textContent='失败：'+e1.message; return; }
  const upd = { last_result:result, last_contact_date:new Date().toISOString() };
  const { data:cur } = await sb.from('visitors').select('status').eq('id',fbVisitor).single();
  if (result==='已联系' && cur && cur.status==='跟进中') upd.status='已联系';
  await sb.from('visitors').update(upd).eq('id',fbVisitor);
  closeModal(); renderActive();
}

// ---------- 用户管理（卡片式，适合手机）----------
async function loadUsers(){
  await loadProfiles();
  const pending = PROFILES.filter(p=>!p.approved);
  const note = pending.length
    ? `<div class="card" style="border-left:4px solid var(--red)"><b style="color:var(--red)">有 ${pending.length} 位新注册用户待批准</b></div>` : '';
  const roleOpts = p => ['volunteer','leader','admin'].map(r=>
    `<option value="${r}" ${p.role===r?'selected':''}>${ROLE_LABEL[r]}</option>`).join('');
  $('users-list').innerHTML = note + PROFILES.map(p=>`
    <div class="card"${!p.approved?' style="border-left:4px solid var(--red)"':''}>
      <div class="vh"><span class="vn">${esc(p.name)||'（未填名）'}</span>
        ${ p.approved ? '<span class="badge b-已联系">✓ 已批准</span>'
                       : `<button class="btn btn-sm" onclick="setApproved('${p.id}',true)">批准登录</button>` }</div>
      <div class="meta">${esc(p.email)}</div>
      <div class="mrow"><label>角色</label>
        <select onchange="setRole('${p.id}',this.value)">${roleOpts(p)}</select></div>
      <div class="mrow"><label>区域</label>
        <input type="text" value="${esc(p.area)||''}" placeholder="负责区域（可选）" onchange="setArea('${p.id}',this.value)"></div>
      <label class="opt"><input type="checkbox" ${p.active!==false?'checked':''} onchange="setActive('${p.id}',this.checked)"> 启用该同工（用于自动分配）</label>
      ${ p.approved ? `<div style="margin-top:.5rem"><button class="del" onclick="setApproved('${p.id}',false)">撤销批准</button></div>` : '' }
    </div>`).join('');
}
async function setApproved(id,b){ await sb.from('profiles').update({approved:b}).eq('id',id); loadUsers(); }
async function setRole(id,r){ await sb.from('profiles').update({role:r}).eq('id',id); }
async function setArea(id,a){ await sb.from('profiles').update({area:a}).eq('id',id); }
async function setActive(id,b){ await sb.from('profiles').update({active:b}).eq('id',id); }

// ---------- 小组管理（卡片式）----------
async function loadGroups(){
  const { data:groups } = await sb.from('groups').select('*').order('id');
  $('groups-list').innerHTML = (groups&&groups.length)
    ? groups.map(g=>`<div class="card">
        <div class="vh"><span class="vn">${esc(g.name)}</span>
          <button class="del" onclick="delGroup(${g.id},'${esc(g.name)}')">删除</button></div>
        <div class="meta">覆盖区域：${esc(g.cover_area)||'—'}</div>
        <div class="meta">负责人：${esc(g.leader_name)||'—'}｜${esc(g.leader_email)||'—'}</div>
        <div class="meta">聚会：${esc(g.meet_time)||'—'}</div>
      </div>`).join('')
    : '<p class="muted">还没有小组，用下面表单添加。</p>';
}
async function addGroup(){
  const msg = $('grp-msg'); msg.className='msg';
  const rec = { name:$('g-name').value.trim(), cover_area:$('g-area').value.trim(),
    leader_name:$('g-ln').value.trim(), leader_email:$('g-le').value.trim(), meet_time:$('g-time').value.trim() };
  if (!rec.name){ msg.className='msg err'; msg.textContent='请填写组名'; return; }
  const { error } = await sb.from('groups').insert(rec);
  if (error){ msg.className='msg err'; msg.textContent='失败：'+error.message; return; }
  ['g-name','g-area','g-ln','g-le','g-time'].forEach(id=>$(id).value='');
  msg.className='msg ok'; msg.textContent='已添加';
  loadGroups();
}
async function delGroup(id,name){
  if (!confirm('确定删除小组「'+name+'」？')) return;
  await sb.from('groups').delete().eq('id',id);
  loadGroups();
}
