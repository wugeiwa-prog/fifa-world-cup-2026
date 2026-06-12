import fs from "node:fs";

const FIFA_URL = "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "wc2026_state";
const SUPABASE_ROW_ID = process.env.SUPABASE_ROW_ID || "global";
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE_ALL = process.env.FORCE_ALL === "1";

const TEAM_EN = {
  "墨西哥":"Mexico","南非":"South Africa","韩国":"Korea Republic","捷克":"Czechia","加拿大":"Canada","波黑":"Bosnia and Herzegovina",
  "卡塔尔":"Qatar","瑞士":"Switzerland","巴西":"Brazil","摩洛哥":"Morocco","海地":"Haiti","苏格兰":"Scotland",
  "美国":"USA","巴拉圭":"Paraguay","澳大利亚":"Australia","土耳其":"Türkiye","德国":"Germany","库拉索":"Curaçao",
  "科特迪瓦":"Côte d'Ivoire","厄瓜多尔":"Ecuador","荷兰":"Netherlands","日本":"Japan","瑞典":"Sweden","突尼斯":"Tunisia",
  "比利时":"Belgium","埃及":"Egypt","伊朗":"IR Iran","新西兰":"New Zealand","西班牙":"Spain","佛得角":"Cabo Verde",
  "沙特阿拉伯":"Saudi Arabia","乌拉圭":"Uruguay","法国":"France","塞内加尔":"Senegal","伊拉克":"Iraq","挪威":"Norway",
  "阿根廷":"Argentina","阿尔及利亚":"Algeria","奥地利":"Austria","约旦":"Jordan","葡萄牙":"Portugal","刚果（金）":"Congo DR",
  "乌兹别克斯坦":"Uzbekistan","哥伦比亚":"Colombia","英格兰":"England","克罗地亚":"Croatia","加纳":"Ghana","巴拿马":"Panama"
};

function rawName(name){
  return String(name).replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\s]+/u,"").trim();
}
function matchId(m){return `${m.d}#${m.t}#${rawName(m.h)}#${rawName(m.a)}`;}
function loadMatches(){
  const html = fs.readFileSync("world-cup-2026-schedule.html","utf8");
  const block = html.match(/const RAW_MATCHES=\[([\s\S]*?)\];\n\nconst GROUPS=/);
  if(!block)throw new Error("RAW_MATCHES block not found");
  const src = `[${block[1]}]`;
  return Function(`"use strict";return (${src});`)();
}
function romeKickoffUtc(m){
  const [mo,dd] = m.d.split("-").map(Number);
  const [hh,mm] = m.t.split(":").map(Number);
  return new Date(Date.UTC(2026, mo - 1, dd, hh - 2, mm));
}
function isCandidate(m, now = new Date()){
  if(!FORCE_ALL && m.s)return false;
  const delayMin = m.st === "group" ? 120 : 180;
  return now.getTime() >= romeKickoffUtc(m).getTime() + delayMin * 60_000;
}
function norm(s){
  return String(s||"")
    .normalize("NFD").replace(/\p{Diacritic}/gu,"")
    .replace(/Türkiye/g,"Turkiye")
    .replace(/Cote d'Ivoire/g,"Cote d Ivoire")
    .toLowerCase();
}
function scoreFromWindow(text, homeEn, awayEn){
  const clean = text.replace(/\s+/g," ");
  const n = norm(clean), h = norm(homeEn), a = norm(awayEn);
  const hi = n.indexOf(h), ai = n.indexOf(a);
  if(hi < 0 || ai < 0 || Math.abs(hi - ai) > 900)return null;
  const start = Math.max(0, Math.min(hi, ai) - 260);
  const end = Math.min(clean.length, Math.max(hi, ai) + 420);
  const win = clean.slice(start,end);
  if(!/(full[- ]?time|final|ft|ended|结束|已结束)/i.test(win))return null;
  const patterns = [
    new RegExp(`${escapeRe(homeEn)}.{0,120}?(\\d{1,2})\\s*[-–:]\\s*(\\d{1,2}).{0,120}?${escapeRe(awayEn)}`,"i"),
    new RegExp(`${escapeRe(awayEn)}.{0,120}?(\\d{1,2})\\s*[-–:]\\s*(\\d{1,2}).{0,120}?${escapeRe(homeEn)}`,"i")
  ];
  const first = win.match(patterns[0]);
  if(first)return `${Number(first[1])}-${Number(first[2])}`;
  const second = win.match(patterns[1]);
  if(second)return `${Number(second[2])}-${Number(second[1])}`;
  return null;
}
function escapeRe(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\\ /g,"\\s+");}
async function getOfficialText(){
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try{
    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });
    await page.goto(FIFA_URL, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(5000);
    return await page.evaluate(() => document.body.innerText);
  }finally{
    await browser.close();
  }
}
async function remoteFetch(method, path, body){
  const url = `${SUPABASE_URL.replace(/\/$/,"")}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    ...(body ? {"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=representation"} : {})
  };
  const res = await fetch(url,{method,headers,body:body?JSON.stringify(body):undefined});
  if(!res.ok)throw new Error(`Supabase ${method} ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
async function loadState(){
  const rows = await remoteFetch("GET",`${SUPABASE_TABLE}?id=eq.${encodeURIComponent(SUPABASE_ROW_ID)}&select=data`);
  return Array.isArray(rows) && rows[0]?.data ? rows[0].data : {users:{},bets:[],daily:{},results:{},resultSync:{}};
}
async function saveState(data){
  const updated_at = new Date().toISOString();
  await remoteFetch("POST",SUPABASE_TABLE,{id:SUPABASE_ROW_ID,data,updated_at});
}

const matches = loadMatches();
const state = await loadState();
state.results ||= {};
state.resultSync ||= {};

const candidates = matches.filter(m => isCandidate(m) && !state.results[matchId(m)]);
console.log(`Candidate matches: ${candidates.length}`);
if(!candidates.length){
  state.resultSync = {source:"FIFA", mode:"post-match-only", lastCheckedAt:new Date().toISOString(), updated:0};
  if(!DRY_RUN)await saveState(state);
  process.exit(0);
}

const officialText = await getOfficialText();
let updated = 0;
for(const m of candidates){
  const home = rawName(m.h), away = rawName(m.a);
  const score = scoreFromWindow(officialText, TEAM_EN[home] || home, TEAM_EN[away] || away);
  if(!score){
    console.log(`No final score found: ${home} vs ${away}`);
    continue;
  }
  state.results[matchId(m)] = {
    score,
    status:"final",
    source:"FIFA",
    updatedAt:new Date().toISOString()
  };
  updated += 1;
  console.log(`Final: ${home} ${score} ${away}`);
}
state.resultSync = {source:"FIFA", mode:"post-match-only", lastCheckedAt:new Date().toISOString(), updated};
if(DRY_RUN){
  console.log("DRY_RUN=1, not writing Supabase");
}else{
  await saveState(state);
  console.log(`Supabase updated. New results: ${updated}`);
}
