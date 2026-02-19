/* ============================================================
   app.js — Calendar Application + Supabase sync
   ============================================================ */
'use strict';

// ── Supabase ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://oungvayvmxkszsokxwxd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91bmd2YXl2bXhrc3pzb2t4d3hkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE1MDEyODgsImV4cCI6MjA4NzA3NzI4OH0.pfwa_xQDlm6Mba3Rw4hx2V9LB1Qf__EioCW-NOGHenQ';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Constants ─────────────────────────────────────────────────────────────────

const MONTHS_EN = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];
const MONTHS_JA = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
const DAYS_JA   = ['日','月','火','水','木','金','土'];

const PRESET_COLORS = [
  '#e03131','#c2255c','#9c36b5','#6741d9','#3b5bdb','#1971c2',
  '#0c8599','#087f5b','#2f9e44','#74b816','#e67700','#f76707',
  '#ff6b6b','#748ffc','#63e6be','#a9e34b','#ffd43b','#845ef7'
];

const DEFAULT_CATEGORIES = [
  { id:1, name:'仕事',   color:'#e67700', type:'normal' },
  { id:2, name:'個人',   color:'#845ef7', type:'normal' },
  { id:3, name:'健康',   color:'#2f9e44', type:'normal' },
  { id:4, name:'締切',   color:'#e03131', type:'normal' },
  { id:5, name:'バイト', color:'#1971c2', type:'shift', hourlyWage:1100,
    templates:[
      { label:'夕方', start:'17:00', end:'22:00', breakMin:60 },
      { label:'昼間', start:'10:00', end:'15:00', breakMin:45 }
    ]
  }
];

// ── State ─────────────────────────────────────────────────────────────────────

let categories     = [];
let events         = {};          // { dateKey: [ eventObj, … ] }
let curDate        = new Date();
let selectedKey    = null;
let selectedCatId  = null;
let editingCats    = [];
let colorTargetIdx = null;
let isDark         = loadLocalJSON('cal_dark') ?? false;
let activeTab      = 'event';
let currentUser    = null;

// ── Local helpers (theme / misc only — data lives in Supabase) ────────────────

function loadLocalJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function saveLocalJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

function dateKey(y, m, d) {
  return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function getCat(id)   { return categories.find(c => c.id === id); }
function normalCats() { return categories.filter(c => c.type !== 'shift'); }
function shiftCats()  { return categories.filter(c => c.type === 'shift'); }
function isShift(id)  { return getCat(id)?.type === 'shift'; }

function catCounts() {
  const c = Object.fromEntries(categories.map(cat => [cat.id, 0]));
  Object.values(events).forEach(arr => arr.forEach(ev => {
    if (c[ev.catId] !== undefined) c[ev.catId]++;
  }));
  return c;
}

// ── Wage helpers ──────────────────────────────────────────────────────────────

function calcShift(ev) {
  if (!ev.shiftStart || !ev.shiftEnd)
    return { totalMinutes:0, breakMinutes:0, workMinutes:0, pay:0 };
  const [sh,sm] = ev.shiftStart.split(':').map(Number);
  const [eh,em] = ev.shiftEnd.split(':').map(Number);
  let total = (eh*60+em) - (sh*60+sm);
  if (total <= 0) total += 1440;
  const brk  = Math.max(0, ev.breakMinutes ?? 0);
  const work = Math.max(0, total - brk);
  const wage = getCat(ev.catId)?.hourlyWage ?? 0;
  return { totalMinutes:total, breakMinutes:brk, workMinutes:work, pay:Math.floor(work/60*wage) };
}

function fmtMin(m) { const h=Math.floor(m/60),r=m%60; return r?`${h}h${r}m`:`${h}h`; }
function fmtYen(n) { return '¥'+Math.round(n).toLocaleString('ja-JP'); }

function monthlySalary() {
  const y=curDate.getFullYear(), m=curDate.getMonth();
  const dim=new Date(y,m+1,0).getDate(), res={};
  for (let d=1;d<=dim;d++) {
    (events[dateKey(y,m,d)]||[]).filter(ev=>isShift(ev.catId)).forEach(ev=>{
      const {workMinutes,pay}=calcShift(ev);
      if (!res[ev.catId]) res[ev.catId]={workMinutes:0,pay:0};
      res[ev.catId].workMinutes+=workMinutes;
      res[ev.catId].pay+=pay;
    });
  }
  return res;
}

// ── Sync indicator ────────────────────────────────────────────────────────────

function setSyncStatus(status) { // 'syncing' | 'synced' | 'error'
  const el = document.getElementById('js-sync-indicator');
  if (!el) return;
  el.className = 'sync-indicator ' + status;
  el.title = status === 'syncing' ? '同期中...' : status === 'synced' ? '同期済み' : '同期エラー';
}

// ── Supabase: load data ───────────────────────────────────────────────────────

async function loadFromSupabase() {
  setSyncStatus('syncing');
  try {
    const uid = currentUser.id;

    // Load categories
    const { data: cats, error: cErr } = await db
      .from('categories')
      .select('*')
      .eq('user_id', uid)
      .order('sort_order');

    if (cErr) throw cErr;

    if (cats && cats.length > 0) {
      categories = cats.map(r => ({
        id:          r.cat_id,
        name:        r.name,
        color:       r.color,
        type:        r.type,
        hourlyWage:  r.hourly_wage ?? undefined,
        templates:   r.templates ?? []
      }));
    } else {
      // First login: seed defaults
      categories = deepClone(DEFAULT_CATEGORIES);
      await saveCategoriesToSupabase();
    }

    // Load events
    const { data: evs, error: eErr } = await db
      .from('events')
      .select('*')
      .eq('user_id', uid);

    if (eErr) throw eErr;

    events = {};
    (evs || []).forEach(r => {
      const key = r.date_key;
      if (!events[key]) events[key] = [];
      events[key].push({
        _dbId:        r.id,
        catId:        r.cat_id,
        title:        r.title,
        time:         r.time    ?? '',
        shiftStart:   r.shift_start ?? '',
        shiftEnd:     r.shift_end   ?? '',
        breakMinutes: r.break_minutes ?? 0
      });
    });

    selectedCatId = normalCats()[0]?.id ?? categories[0]?.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Load error:', e);
    setSyncStatus('error');
  }
}

// ── Supabase: save categories ─────────────────────────────────────────────────

async function saveCategoriesToSupabase() {
  setSyncStatus('syncing');
  try {
    const uid = currentUser.id;
    // Upsert all categories
    const rows = categories.map((cat, i) => ({
      user_id:     uid,
      cat_id:      cat.id,
      name:        cat.name,
      color:       cat.color,
      type:        cat.type,
      hourly_wage: cat.hourlyWage ?? null,
      templates:   cat.templates  ?? [],
      sort_order:  i
    }));

    const { error } = await db
      .from('categories')
      .upsert(rows, { onConflict: 'user_id,cat_id' });

    if (error) throw error;

    // Delete removed categories
    const validIds = categories.map(c => c.id);
    await db.from('categories')
      .delete()
      .eq('user_id', uid)
      .not('cat_id', 'in', `(${validIds.join(',')})`);

    setSyncStatus('synced');
  } catch (e) {
    console.error('Save cats error:', e);
    setSyncStatus('error');
  }
}

// ── Supabase: add event ───────────────────────────────────────────────────────

async function addEventToSupabase(key, ev) {
  setSyncStatus('syncing');
  try {
    const { data, error } = await db.from('events').insert({
      user_id:       currentUser.id,
      date_key:      key,
      cat_id:        ev.catId,
      title:         ev.title        ?? '',
      time:          ev.time         || null,
      shift_start:   ev.shiftStart   || null,
      shift_end:     ev.shiftEnd     || null,
      break_minutes: ev.breakMinutes ?? 0
    }).select().single();

    if (error) throw error;
    ev._dbId = data.id;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Add event error:', e);
    setSyncStatus('error');
  }
}

// ── Supabase: delete event ────────────────────────────────────────────────────

async function deleteEventFromSupabase(ev) {
  if (!ev._dbId) return;
  setSyncStatus('syncing');
  try {
    const { error } = await db.from('events').delete().eq('id', ev._dbId);
    if (error) throw error;
    setSyncStatus('synced');
  } catch (e) {
    console.error('Delete event error:', e);
    setSyncStatus('error');
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}
function toggleTheme() {
  isDark = !isDark; applyTheme(isDark); saveLocalJSON('cal_dark', isDark);
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function showAuthScreen() {
  document.getElementById('js-auth-screen').style.display = '';
  document.getElementById('js-app').style.display = 'none';
}

async function showApp(user) {
  currentUser = user;
  document.getElementById('js-auth-screen').style.display = 'none';
  document.getElementById('js-app').style.display = '';
  document.getElementById('js-user-email').textContent = user.email ?? user.user_metadata?.full_name ?? '';

  await loadFromSupabase();
  renderAll();
}

// Auth tab switch
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.toggle('is-active', b === btn));
    const isLogin = btn.dataset.tab === 'login';
    document.getElementById('js-auth-submit').textContent = isLogin ? 'ログイン' : '新規登録';
    document.getElementById('js-auth-password').autocomplete = isLogin ? 'current-password' : 'new-password';
  });
});

// Email/password submit
document.getElementById('js-auth-submit').addEventListener('click', async () => {
  const email    = document.getElementById('js-auth-email').value.trim();
  const password = document.getElementById('js-auth-password').value;
  const isLogin  = document.querySelector('.auth-tab.is-active').dataset.tab === 'login';
  const errEl    = document.getElementById('js-auth-error');
  const loadEl   = document.getElementById('js-auth-loading');

  errEl.style.display  = 'none';
  loadEl.style.display = '';

  try {
    let result;
    if (isLogin) {
      result = await db.auth.signInWithPassword({ email, password });
    } else {
      result = await db.auth.signUp({ email, password });
    }
    if (result.error) throw result.error;
    if (!isLogin && !result.data.session) {
      errEl.textContent  = '確認メールを送信しました。メールのリンクをクリックしてください。';
      errEl.style.display = '';
      errEl.style.color  = 'var(--color-positive)';
    }
  } catch (e) {
    errEl.textContent   = e.message;
    errEl.style.display = '';
    errEl.style.color   = '';
  } finally {
    loadEl.style.display = 'none';
  }
});

// Google OAuth
document.getElementById('js-auth-google').addEventListener('click', async () => {
  await db.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href }
  });
});

// Logout
document.getElementById('js-logout').addEventListener('click', async () => {
  await db.auth.signOut();
  currentUser = null;
  categories  = [];
  events      = {};
  showAuthScreen();
});

// Auth state listener
db.auth.onAuthStateChange((_event, session) => {
  if (session?.user) {
    showApp(session.user);
  } else {
    showAuthScreen();
  }
});

// ── Salary summary ────────────────────────────────────────────────────────────

function renderSalarySummary() {
  const box     = document.getElementById('js-salary-summary');
  const summary = monthlySalary();
  box.innerHTML = '';

  const active = shiftCats().filter(c => summary[c.id]);
  if (!active.length) {
    box.innerHTML = '<div class="salary-empty">シフトの記録がありません</div>';
    return;
  }

  let total = 0;
  active.forEach(cat => {
    const { workMinutes, pay } = summary[cat.id];
    total += pay;
    const row = document.createElement('div');
    row.className = 'salary-job-row';
    row.innerHTML = `
      <span class="salary-job-dot" style="background:${cat.color}"></span>
      <span class="salary-job-name">${escHtml(cat.name)}</span>
      <span class="salary-job-hours">${fmtMin(workMinutes)}</span>
      <span class="salary-job-amount">${fmtYen(pay)}</span>`;
    box.appendChild(row);
  });

  const tot = document.createElement('div');
  tot.className = 'salary-total-row';
  tot.style.marginTop = '4px';
  tot.innerHTML = `<span class="salary-total-label">合計</span>
                   <span class="salary-total-amount">${fmtYen(total)}</span>`;
  if (active.length > 1) box.insertAdjacentHTML('beforeend','<div class="salary-divider"></div>');
  box.appendChild(tot);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderSidebar() {
  const counts = catCounts();
  const list   = document.getElementById('js-category-list');
  list.innerHTML = '';

  categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';
    const tag = cat.type==='shift'
      ? ` <small style="font-size:9px;opacity:.5;font-weight:600">⏱ ${cat.hourlyWage?fmtYen(cat.hourlyWage)+'/h':''}</small>`
      : '';
    row.innerHTML = `
      <span class="cat-color-dot" style="background:${cat.color}"></span>
      <span class="cat-row-name">${escHtml(cat.name)}${tag}</span>
      <span class="cat-row-count">${counts[cat.id]||''}</span>
      <span class="cat-row-actions">
        <button class="cat-row-edit-btn" title="編集">•••</button>
      </span>`;
    row.querySelector('.cat-row-edit-btn').addEventListener('click', e => {
      e.stopPropagation(); openCatEditor();
    });
    list.appendChild(row);
  });

  renderSalarySummary();
}

// ── Mini calendar ─────────────────────────────────────────────────────────────

function renderMini() {
  const y=curDate.getFullYear(), m=curDate.getMonth(), today=new Date();
  document.getElementById('js-mini-month').textContent = `${y}年${m+1}月`;
  const grid=document.getElementById('js-mini-grid');
  grid.innerHTML='';
  const first=new Date(y,m,1).getDay(), dim=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();

  for (let i=first-1;i>=0;i--) grid.appendChild(mkMini(prev-i,true,false,false,false,false));
  for (let d=1;d<=dim;d++) {
    const dow=new Date(y,m,d).getDay();
    const isTd=y===today.getFullYear()&&m===today.getMonth()&&d===today.getDate();
    const el=mkMini(d,false,isTd,!!(events[dateKey(y,m,d)]?.length),dow===0,dow===6);
    el.addEventListener('click',()=>openDayModal(y,m,d));
    grid.appendChild(el);
  }
  const rem=grid.children.length%7;
  if (rem) for (let d=1;d<=7-rem;d++) grid.appendChild(mkMini(d,true,false,false,false,false));
}

function mkMini(day,isOther,isToday,hasEv,isSun,isSat) {
  const el=document.createElement('div');
  el.className=['mini-day',isOther?'is-other':'',isToday?'is-today':'',
    hasEv?'has-events':'',isSun?'is-sun':'',isSat?'is-sat':''].filter(Boolean).join(' ');
  el.textContent=day;
  return el;
}

// ── Main calendar ─────────────────────────────────────────────────────────────

function renderMain() {
  const y=curDate.getFullYear(), m=curDate.getMonth(), today=new Date();
  document.getElementById('js-topbar-title').textContent=`${MONTHS_EN[m]} ${y}`;
  document.getElementById('js-topbar-sub').textContent=`${y}年 ${MONTHS_JA[m]}`;

  const grid=document.getElementById('js-cal-grid');
  grid.innerHTML='';
  const first=new Date(y,m,1).getDay(), dim=new Date(y,m+1,0).getDate(), prev=new Date(y,m,0).getDate();

  for (let i=first-1;i>=0;i--) {
    const dt=new Date(y,m-1,prev-i);
    grid.appendChild(buildCell(dt.getFullYear(),dt.getMonth(),dt.getDate(),true,false));
  }
  for (let d=1;d<=dim;d++) {
    const isTd=y===today.getFullYear()&&m===today.getMonth()&&d===today.getDate();
    grid.appendChild(buildCell(y,m,d,false,isTd));
  }
  const rem=grid.children.length%7;
  if (rem) for (let d=1;d<=7-rem;d++) {
    const dt=new Date(y,m+1,d);
    grid.appendChild(buildCell(dt.getFullYear(),dt.getMonth(),d,true,false));
  }
}

function sortEvs(arr) {
  return [...arr].sort((a,b)=>(a.shiftStart||a.time||'99:99').localeCompare(b.shiftStart||b.time||'99:99'));
}

function buildCell(y,m,d,isOther,isToday) {
  const dow=new Date(y,m,d).getDay(), key=dateKey(y,m,d), dayEvs=sortEvs(events[key]||[]);
  const cell=document.createElement('div');
  cell.className=['day-cell',isOther?'is-other-month':'',isToday?'is-today':'',
    dow===0?'is-sun':'',dow===6?'is-sat':''].filter(Boolean).join(' ');

  const numEl=document.createElement('div');
  numEl.className='day-num'; numEl.textContent=d;
  cell.appendChild(numEl);

  // Day wage badge
  const shifts=dayEvs.filter(ev=>isShift(ev.catId));
  if (shifts.length) {
    const dayPay=shifts.reduce((s,ev)=>s+calcShift(ev).pay,0);
    const dayWork=shifts.reduce((s,ev)=>s+calcShift(ev).workMinutes,0);
    const badge=document.createElement('div');
    badge.className='day-wage-badge';
    badge.textContent=fmtYen(dayPay);
    badge.title=`勤務 ${fmtMin(dayWork)}`;
    cell.appendChild(badge);
  }

  if (dayEvs.length) {
    const evList=document.createElement('div');
    evList.className='day-events';
    dayEvs.slice(0,3).forEach(ev=>{
      const cat=getCat(ev.catId)||{color:'#888'};
      const pill=document.createElement('div');
      pill.className='event-pill'+(isShift(ev.catId)?' is-shift':'');
      pill.style.background=cat.color;
      if (isShift(ev.catId)&&ev.shiftStart) {
        pill.innerHTML=`<span class="event-pill-time">${ev.shiftStart}–${ev.shiftEnd}</span>
                        <span class="event-pill-name">${escHtml(cat.name)}</span>`;
      } else {
        pill.innerHTML=ev.time
          ?`<span class="event-pill-time">${ev.time}</span><span class="event-pill-name">${escHtml(ev.title)}</span>`
          :`<span class="event-pill-dot"></span><span class="event-pill-name">${escHtml(ev.title)}</span>`;
      }
      pill.addEventListener('click',e=>{e.stopPropagation();openDayModal(y,m,d);});
      evList.appendChild(pill);
    });
    if (dayEvs.length>3) {
      const more=document.createElement('div');
      more.className='more-badge'; more.textContent=`+${dayEvs.length-3} 件`;
      evList.appendChild(more);
    }
    cell.appendChild(evList);
  }
  cell.addEventListener('click',()=>openDayModal(y,m,d));
  return cell;
}

// ── Day modal ─────────────────────────────────────────────────────────────────

function openDayModal(y,m,d) {
  selectedKey=dateKey(y,m,d);
  const dow=new Date(y,m,d).getDay();
  document.getElementById('js-day-modal-title').textContent=`${y}年 ${MONTHS_JA[m]} ${d}日`;
  document.getElementById('js-day-modal-sub').textContent=`${DAYS_JA[dow]}曜日`;

  document.getElementById('js-ev-title').value='';
  document.getElementById('js-ev-time').value='';
  if (!getCat(selectedCatId)) selectedCatId=normalCats()[0]?.id??categories[0]?.id;

  document.getElementById('js-shift-start').value='';
  document.getElementById('js-shift-end').value='';
  document.getElementById('js-shift-break').value='';
  updateWagePreview();

  renderExistingEvents();
  renderCatChips();
  renderTemplateChips();
  updateShiftTabVisibility();
  switchTab(activeTab);
  openOverlay('js-day-overlay');
  setTimeout(()=>{
    (activeTab==='shift'
      ?document.getElementById('js-shift-start')
      :document.getElementById('js-ev-title'))?.focus();
  },80);
}

document.querySelectorAll('.form-tab').forEach(btn=>{
  btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  activeTab=tab;
  document.querySelectorAll('.form-tab').forEach(b=>b.classList.toggle('is-active',b.dataset.tab===tab));
  document.getElementById('js-tab-event').style.display=tab==='event'?'':'none';
  document.getElementById('js-tab-shift').style.display=tab==='shift'?'':'none';
}

function updateShiftTabVisibility() {
  const has=shiftCats().length>0;
  document.getElementById('js-no-shift-warning').style.display=has?'none':'';
  document.getElementById('js-add-shift-btn').style.display=has?'':'none';
  document.getElementById('js-wage-preview').style.display=has?'':'none';
}

document.getElementById('js-go-to-cat-editor').addEventListener('click',()=>{
  closeOverlay('js-day-overlay'); openCatEditor();
});

// ── Template chips ────────────────────────────────────────────────────────────

function renderTemplateChips() {
  const row=document.getElementById('js-template-row');
  const list=document.getElementById('js-template-chip-list');
  list.innerHTML='';
  const all=[];
  shiftCats().forEach(cat=>(cat.templates||[]).forEach(tpl=>all.push({cat,tpl})));
  if (!all.length){row.style.display='none';return;}
  row.style.display='';
  all.forEach(({cat,tpl})=>{
    const chip=document.createElement('button');
    chip.className='template-chip';
    const mock={shiftStart:tpl.start,shiftEnd:tpl.end,breakMinutes:tpl.breakMin,catId:cat.id};
    const {pay}=calcShift(mock);
    const payStr=cat.hourlyWage?`　${fmtYen(pay)}`:'';
    chip.innerHTML=`
      <span class="template-chip-dot" style="background:${cat.color}"></span>
      <span>${escHtml(tpl.label||`${tpl.start}–${tpl.end}`)}</span>
      <span style="opacity:.5;font-size:10px">${tpl.start}–${tpl.end}${payStr}</span>`;
    chip.addEventListener('click',()=>{
      document.getElementById('js-shift-start').value=tpl.start;
      document.getElementById('js-shift-end').value=tpl.end;
      document.getElementById('js-shift-break').value=tpl.breakMin??0;
      updateWagePreview();
      switchTab('shift');
    });
    list.appendChild(chip);
  });
}

// ── Existing events list ──────────────────────────────────────────────────────

function renderExistingEvents() {
  const container=document.getElementById('js-existing-events');
  container.innerHTML='';
  const dayEvs=sortEvs(events[selectedKey]||[]);
  if (!dayEvs.length){container.innerHTML='<div class="empty-state">まだ予定はありません</div>';return;}

  dayEvs.forEach(ev=>{
    const cat=getCat(ev.catId)||{color:'#888',name:'?'};
    const row=document.createElement('div');
    row.className='event-list-row';
    let titleHtml,metaHtml;
    if (isShift(ev.catId)&&ev.shiftStart) {
      const {workMinutes,breakMinutes,pay}=calcShift(ev);
      const brk=breakMinutes>0?`休憩${breakMinutes}分　`:'';
      titleHtml=`<span class="ev-cat-chip" style="background:${cat.color}">${escHtml(cat.name)}</span>`;
      metaHtml=`<span class="ev-shift-time">${ev.shiftStart} – ${ev.shiftEnd}</span>
                <span>${brk}勤務 ${fmtMin(workMinutes)}</span>
                <span class="ev-shift-pay">${fmtYen(pay)}</span>`;
    } else {
      titleHtml=escHtml(ev.title);
      metaHtml=(ev.time?`<span>${ev.time}</span>`:'')+
               `<span class="ev-cat-chip" style="background:${cat.color}">${escHtml(cat.name)}</span>`;
    }
    row.innerHTML=`
      <span class="ev-color-dot" style="background:${cat.color}"></span>
      <div class="ev-info">
        <div class="ev-title">${titleHtml}</div>
        <div class="ev-meta">${metaHtml}</div>
      </div>
      <button class="ev-delete-btn" title="削除">✕</button>`;
    row.querySelector('.ev-delete-btn').addEventListener('click',async()=>{
      const arr=events[selectedKey];
      const idx=arr.indexOf(ev);
      if (idx!==-1) {
        await deleteEventFromSupabase(ev);
        arr.splice(idx,1);
        if (!arr.length) delete events[selectedKey];
        renderExistingEvents();
        renderAll();
      }
    });
    container.appendChild(row);
  });
}

// ── Cat chips ─────────────────────────────────────────────────────────────────

function renderCatChips() {
  const list=document.getElementById('js-cat-chip-list');
  list.innerHTML='';
  normalCats().forEach(cat=>{
    const sel=cat.id===selectedCatId;
    const chip=document.createElement('div');
    chip.className='cat-chip'+(sel?' is-selected':'');
    if (sel) chip.style.background=cat.color;
    chip.innerHTML=`<span class="cat-chip-dot" style="background:${sel?'rgba(255,255,255,.7)':cat.color}"></span>${escHtml(cat.name)}`;
    chip.addEventListener('click',()=>{selectedCatId=cat.id;renderCatChips();});
    list.appendChild(chip);
  });
}

// ── Add normal event ──────────────────────────────────────────────────────────

document.getElementById('js-add-event-btn').addEventListener('click',addEvent);
document.getElementById('js-ev-title').addEventListener('keydown',e=>{if(e.key==='Enter')addEvent();});

async function addEvent() {
  const title=document.getElementById('js-ev-title').value.trim();
  if (!title){document.getElementById('js-ev-title').focus();return;}
  const time=document.getElementById('js-ev-time').value;
  const ev={title,time,catId:selectedCatId};
  if (!events[selectedKey]) events[selectedKey]=[];
  events[selectedKey].push(ev);
  await addEventToSupabase(selectedKey,ev);
  document.getElementById('js-ev-title').value='';
  document.getElementById('js-ev-time').value='';
  renderExistingEvents();
  renderAll();
}

// ── Shift wage preview ────────────────────────────────────────────────────────

['js-shift-start','js-shift-end','js-shift-break'].forEach(id=>{
  document.getElementById(id).addEventListener('input',updateWagePreview);
});

function updateWagePreview() {
  const start=document.getElementById('js-shift-start').value;
  const end=document.getElementById('js-shift-end').value;
  const brk=parseInt(document.getElementById('js-shift-break').value)||0;
  const cat=shiftCats()[0];
  const hEl=document.getElementById('js-preview-hours');
  const bEl=document.getElementById('js-preview-break');
  const pEl=document.getElementById('js-preview-pay');
  if (!start||!end||!cat){hEl.textContent='—';bEl.textContent='—';pEl.textContent='—';return;}
  const {totalMinutes,workMinutes,pay}=calcShift({shiftStart:start,shiftEnd:end,breakMinutes:brk,catId:cat.id});
  hEl.textContent=`${fmtMin(totalMinutes)}（実働 ${fmtMin(workMinutes)}）`;
  bEl.textContent=brk>0?`${brk}分`:'なし';
  pEl.textContent=fmtYen(pay);
}

// ── Add shift ─────────────────────────────────────────────────────────────────

document.getElementById('js-add-shift-btn').addEventListener('click',addShift);

async function addShift() {
  const start=document.getElementById('js-shift-start').value;
  const end=document.getElementById('js-shift-end').value;
  const brk=parseInt(document.getElementById('js-shift-break').value)||0;
  const cat=shiftCats()[0];
  if (!start||!end){document.getElementById('js-shift-start').focus();return;}
  if (!cat) return;
  const ev={title:'',catId:cat.id,shiftStart:start,shiftEnd:end,breakMinutes:brk};
  if (!events[selectedKey]) events[selectedKey]=[];
  events[selectedKey].push(ev);
  await addEventToSupabase(selectedKey,ev);
  document.getElementById('js-shift-start').value='';
  document.getElementById('js-shift-end').value='';
  document.getElementById('js-shift-break').value='';
  updateWagePreview();
  renderExistingEvents();
  renderAll();
}

// ── Category editor ───────────────────────────────────────────────────────────

function openCatEditor() {
  editingCats=deepClone(categories);
  renderCatEditorList();
  openOverlay('js-cat-overlay');
}

function renderCatEditorList() {
  const list=document.getElementById('js-cat-editor-list');
  list.innerHTML='';
  editingCats.forEach((cat,idx)=>{
    const isS=cat.type==='shift';
    const wrap=document.createElement('div');

    const row=document.createElement('div');
    row.className='cat-editor-row';
    row.innerHTML=`
      <button class="cat-color-swatch" style="background:${cat.color}" title="色を変更"></button>
      <input  class="cat-name-field" type="text" value="${escHtml(cat.name)}" placeholder="カテゴリ名" />
      <div class="cat-type-toggle">
        <button class="cat-type-btn ${!isS?'is-active':''}" data-type="normal">予定</button>
        <button class="cat-type-btn ${isS?'is-active':''}" data-type="shift">バイト</button>
      </div>
      <button class="cat-delete-btn" title="削除">🗑</button>`;

    const wageRow=document.createElement('div');
    wageRow.className='cat-wage-row'+(isS?' is-visible':'');
    wageRow.innerHTML=`
      <span class="cat-wage-label">時給</span>
      <input class="cat-wage-input" type="number" value="${cat.hourlyWage||''}" placeholder="1000" min="0" />
      <span class="cat-wage-unit">円 / h</span>`;

    const tplSection=document.createElement('div');
    tplSection.className='tpl-section'+(isS?' is-visible':'');

    function rebuildTpls() {
      tplSection.innerHTML='';
      const tpls=cat.templates||[];
      if (tpls.length){
        const lbl=document.createElement('div');
        lbl.className='tpl-section-label'; lbl.textContent='シフトテンプレート';
        tplSection.appendChild(lbl);
      }
      tpls.forEach((tpl,ti)=>{
        const trow=document.createElement('div'); trow.className='tpl-row';
        trow.innerHTML=`
          <input class="tpl-input" type="text"   placeholder="名前"     value="${escHtml(tpl.label||'')}"  data-field="label" />
          <input class="tpl-input" type="time"   value="${tpl.start||''}" data-field="start" />
          <span  class="tpl-sep">〜</span>
          <input class="tpl-input" type="time"   value="${tpl.end||''}"   data-field="end"   />
          <input class="tpl-input tpl-break-input" type="number" value="${tpl.breakMin??''}" placeholder="休憩(分)" min="0" data-field="breakMin" />
          <button class="tpl-delete-btn" title="削除">✕</button>`;
        trow.querySelectorAll('.tpl-input').forEach(inp=>{
          inp.addEventListener('input',e=>{
            const f=e.target.dataset.field;
            editingCats[idx].templates[ti][f]=f==='breakMin'?parseInt(e.target.value)||0:e.target.value;
          });
        });
        trow.querySelector('.tpl-delete-btn').addEventListener('click',()=>{
          editingCats[idx].templates.splice(ti,1); rebuildTpls();
        });
        tplSection.appendChild(trow);
      });
      const addBtn=document.createElement('button');
      addBtn.className='add-tpl-btn'; addBtn.textContent='＋ テンプレートを追加';
      addBtn.addEventListener('click',()=>{
        if (!editingCats[idx].templates) editingCats[idx].templates=[];
        editingCats[idx].templates.push({label:'',start:'',end:'',breakMin:0});
        rebuildTpls();
        requestAnimationFrame(()=>{
          const ins=tplSection.querySelectorAll('.tpl-input[data-field="label"]');
          ins[ins.length-1]?.focus();
        });
      });
      tplSection.appendChild(addBtn);
    }
    rebuildTpls();

    row.querySelector('.cat-color-swatch').addEventListener('click',e=>openColorPopup(e.currentTarget,idx));
    row.querySelector('.cat-name-field').addEventListener('input',e=>{editingCats[idx].name=e.target.value;});
    row.querySelectorAll('.cat-type-btn').forEach(btn=>{
      btn.addEventListener('click',()=>{
        editingCats[idx].type=btn.dataset.type;
        if (btn.dataset.type!=='shift'){delete editingCats[idx].hourlyWage;delete editingCats[idx].templates;}
        renderCatEditorList();
      });
    });
    wageRow.querySelector('.cat-wage-input').addEventListener('input',e=>{
      editingCats[idx].hourlyWage=parseInt(e.target.value)||0;
    });
    row.querySelector('.cat-delete-btn').addEventListener('click',()=>{
      editingCats.splice(idx,1); renderCatEditorList();
    });

    wrap.appendChild(row); wrap.appendChild(wageRow); wrap.appendChild(tplSection);
    list.appendChild(wrap);
  });
}

document.getElementById('js-add-cat-row').addEventListener('click',()=>{
  const used=new Set(editingCats.map(c=>c.color));
  const color=PRESET_COLORS.find(c=>!used.has(c))??PRESET_COLORS[editingCats.length%PRESET_COLORS.length];
  const maxId=editingCats.reduce((mx,c)=>Math.max(mx,c.id),0);
  editingCats.push({id:maxId+1,name:'新カテゴリ',color,type:'normal'});
  renderCatEditorList();
  requestAnimationFrame(()=>{
    const ins=document.querySelectorAll('.cat-name-field');
    if (ins.length){ins[ins.length-1].focus();ins[ins.length-1].select();}
  });
});

document.getElementById('js-cat-save-btn').addEventListener('click',async()=>{
  categories=editingCats.filter(c=>c.name.trim());
  const valid=new Set(categories.map(c=>c.id));
  // Remove events with deleted cat ids (from Supabase too)
  for (const key of Object.keys(events)) {
    const toDelete=events[key].filter(ev=>!valid.has(ev.catId));
    for (const ev of toDelete) await deleteEventFromSupabase(ev);
    events[key]=events[key].filter(ev=>valid.has(ev.catId));
    if (!events[key].length) delete events[key];
  }
  if (!getCat(selectedCatId)) selectedCatId=normalCats()[0]?.id??categories[0]?.id;
  await saveCategoriesToSupabase();
  closeOverlay('js-cat-overlay');
  closeColorPopup();
  renderAll();
});

['js-cat-cancel-btn','js-cat-modal-close'].forEach(id=>{
  document.getElementById(id).addEventListener('click',()=>{closeOverlay('js-cat-overlay');closeColorPopup();});
});
document.getElementById('js-cat-overlay').addEventListener('click',e=>{
  if (e.target===document.getElementById('js-cat-overlay')){closeOverlay('js-cat-overlay');closeColorPopup();}
});

// ── Color picker ──────────────────────────────────────────────────────────────

const colorPopup=document.getElementById('js-color-popup');

PRESET_COLORS.forEach(color=>{
  const sw=document.createElement('div');
  sw.className='color-swatch'; sw.style.background=color;
  sw.addEventListener('click',()=>{
    if (colorTargetIdx!==null){editingCats[colorTargetIdx].color=color;renderCatEditorList();closeColorPopup();}
  });
  document.getElementById('js-color-swatch-grid').appendChild(sw);
});

document.getElementById('js-custom-color-input').addEventListener('input',e=>{
  if (colorTargetIdx!==null){editingCats[colorTargetIdx].color=e.target.value;renderCatEditorList();}
});

function openColorPopup(el,idx) {
  colorTargetIdx=idx;
  document.getElementById('js-custom-color-input').value=editingCats[idx].color;
  const rect=el.getBoundingClientRect(), popW=196;
  let left=rect.left;
  if (left+popW>window.innerWidth-10) left=window.innerWidth-popW-10;
  colorPopup.style.top=`${rect.bottom+6}px`;
  colorPopup.style.left=`${left}px`;
  colorPopup.classList.add('is-open');
}

function closeColorPopup(){colorPopup.classList.remove('is-open');colorTargetIdx=null;}

document.addEventListener('click',e=>{
  if (colorPopup.classList.contains('is-open')&&!colorPopup.contains(e.target)&&!e.target.classList.contains('cat-color-swatch'))
    closeColorPopup();
});

// ── Overlay helpers ───────────────────────────────────────────────────────────

function openOverlay(id){document.getElementById(id).classList.add('is-open');}
function closeOverlay(id){document.getElementById(id).classList.remove('is-open');}

document.getElementById('js-day-modal-close').addEventListener('click',()=>closeOverlay('js-day-overlay'));
document.getElementById('js-day-overlay').addEventListener('click',e=>{
  if (e.target===document.getElementById('js-day-overlay')) closeOverlay('js-day-overlay');
});

// ── Navigation ────────────────────────────────────────────────────────────────

document.getElementById('js-prev-month').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()-1);renderAll();});
document.getElementById('js-next-month').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()+1);renderAll();});
document.getElementById('js-today').addEventListener('click',()=>{curDate=new Date();renderAll();});
document.getElementById('js-mini-prev').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()-1);renderAll();});
document.getElementById('js-mini-next').addEventListener('click',()=>{curDate.setMonth(curDate.getMonth()+1);renderAll();});
document.getElementById('js-open-cat-editor').addEventListener('click',openCatEditor);
document.getElementById('js-theme-toggle').addEventListener('click',toggleTheme);

document.addEventListener('keydown',e=>{
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key==='ArrowLeft'){curDate.setMonth(curDate.getMonth()-1);renderAll();}
  if (e.key==='ArrowRight'){curDate.setMonth(curDate.getMonth()+1);renderAll();}
  if (e.key.toLowerCase()==='t'){curDate=new Date();renderAll();}
  if (e.key==='Escape'){closeOverlay('js-day-overlay');closeOverlay('js-cat-overlay');closeColorPopup();}
});

// ── XSS guard ─────────────────────────────────────────────────────────────────

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── Render all ────────────────────────────────────────────────────────────────

function renderAll(){renderMain();renderMini();renderSidebar();}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

applyTheme(isDark);
// Auth state change will trigger showApp() → loadFromSupabase() → renderAll()
