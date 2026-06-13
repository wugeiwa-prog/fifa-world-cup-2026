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
const TEAM_CODE = {
  "墨西哥":"MEX","南非":"RSA","韩国":"KOR","捷克":"CZE","加拿大":"CAN","波黑":"BIH","卡塔尔":"QAT","瑞士":"SUI",
  "巴西":"BRA","摩洛哥":"MAR","海地":"HAI","苏格兰":"SCO","美国":"USA","巴拉圭":"PAR","澳大利亚":"AUS","土耳其":"TUR",
  "德国":"GER","库拉索":"CUW","科特迪瓦":"CIV","厄瓜多尔":"ECU","荷兰":"NED","日本":"JPN","瑞典":"SWE","突尼斯":"TUN",
  "比利时":"BEL","埃及":"EGY","伊朗":"IRN","新西兰":"NZL","西班牙":"ESP","佛得角":"CPV","沙特阿拉伯":"KSA","乌拉圭":"URU",
  "法国":"FRA","塞内加尔":"SEN","伊拉克":"IRQ","挪威":"NOR","阿根廷":"ARG","阿尔及利亚":"ALG","奥地利":"AUT","约旦":"JOR",
  "葡萄牙":"POR","刚果（金）":"COD","乌兹别克斯坦":"UZB","哥伦比亚":"COL","英格兰":"ENG","克罗地亚":"CRO","加纳":"GHA","巴拿马":"PAN"
};
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FALLBACK_RESULT_SOURCES = {
  "06-12#21:00#加拿大#波黑": [
    {name:"Canada Soccer",url:"https://canadasoccer.com/match/4696/",parser:"canada-soccer"},
    {name:"FOX Sports",url:"https://www.foxsports.com/soccer/fifa-world-cup-men-canada-vs-bosnia-and-herzegovina-jun-12-2026-game-boxscore-647618",parser:"generic"}
  ]
};

function rawName(name){
  return String(name).replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u{E0060}-\u{E007F}\s]+/u,"").trim();
}
function matchId(m){return `${m.d}#${m.t}#${rawName(m.h)}#${rawName(m.a)}`;}
function loadMatches(){
  const html = fs.readFileSync("world-cup-2026-schedule.html","utf8");
  const block = html.match(/const RAW_MATCHES\s*=\s*\[([\s\S]*?)\]\s*;\s*const GROUPS=/);
  if(!block)throw new Error("RAW_MATCHES block not found");
  const src = `[${block[1]}]`;
  return Function(`"use strict";return (${src});`)();
}
function romeKickoffUtc(m){
  const [mo,dd] = m.d.split("-").map(Number);
  const [hh,mm] = m.t.split(":").map(Number);
  return new Date(Date.UTC(2026, mo - 1, dd, hh - 2, mm));
}
function ymd(date){
  return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,"0")}${String(date.getUTCDate()).padStart(2,"0")}`;
}
function candidateEspnDates(m){
  const kick = romeKickoffUtc(m);
  const dates = new Set();
  dates.add(ymd(kick));
  dates.add(ymd(new Date(kick.getTime() - 6 * 60 * 60_000)));
  dates.add(ymd(new Date(kick.getTime() + 6 * 60 * 60_000)));
  const [mo,dd] = m.d.split("-").map(Number);
  dates.add(`2026${String(mo).padStart(2,"0")}${String(dd).padStart(2,"0")}`);
  return [...dates];
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
function scoreFromCanadaSoccer(html){
  if(!/Full Time/i.test(html))return null;
  const m = html.match(/id=["']match-score["'][^>]*>\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*</i)
    || html.match(/<div class=["']score["'][\s\S]{0,260}?(\d{1,2})\s*[-–]\s*(\d{1,2})[\s\S]{0,260}?Full Time/i);
  return m ? `${Number(m[1])}-${Number(m[2])}` : null;
}
function scoreFromGenericHtml(html, homeEn, awayEn){
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/g," ")
    .replace(/&amp;/g,"&");
  return scoreFromWindow(text, homeEn, awayEn);
}
async function fetchFallbackScore(m){
  const id = matchId(m), sources = FALLBACK_RESULT_SOURCES[id] || [];
  const home = rawName(m.h), away = rawName(m.a);
  for(const source of sources){
    try{
      const html = await fetch(source.url,{headers:{"user-agent":"Mozilla/5.0"}}).then(r=>{
        if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);
        return r.text();
      });
      const score = source.parser === "canada-soccer"
        ? scoreFromCanadaSoccer(html)
        : scoreFromGenericHtml(html, TEAM_EN[home] || home, TEAM_EN[away] || away);
      if(score)return {score, source:source.name, url:source.url};
      console.log(`Fallback source had no final score: ${source.name} ${home} vs ${away}`);
    }catch(e){
      console.warn(`Fallback source failed: ${source.name} ${id}: ${e.message}`);
    }
  }
  return null;
}
const espnCache = new Map();
async function espnScoreboard(dateKey){
  if(espnCache.has(dateKey))return espnCache.get(dateKey);
  const url = `${ESPN_SCOREBOARD_URL}?dates=${dateKey}`;
  const data = await fetch(url,{headers:{"user-agent":"Mozilla/5.0"}}).then(r=>{
    if(!r.ok)throw new Error(`ESPN ${r.status} ${r.statusText}`);
    return r.json();
  });
  espnCache.set(dateKey,{url,events:Array.isArray(data.events)?data.events:[]});
  return espnCache.get(dateKey);
}
function espnTeamKey(team){
  return norm([team?.abbreviation,team?.displayName,team?.shortDisplayName,team?.name,team?.location].filter(Boolean).join(" "));
}
function matchEspnEvent(event, home, away){
  const comp = event.competitions?.[0], competitors = comp?.competitors || [];
  const homeCode = TEAM_CODE[home], awayCode = TEAM_CODE[away];
  const homeEn = TEAM_EN[home] || home, awayEn = TEAM_EN[away] || away;
  const wantedHome = [homeCode, homeEn, home].filter(Boolean).map(norm);
  const wantedAway = [awayCode, awayEn, away].filter(Boolean).map(norm);
  const homeComp = competitors.find(c => c.homeAway === "home");
  const awayComp = competitors.find(c => c.homeAway === "away");
  if(!homeComp || !awayComp)return null;
  const eh = espnTeamKey(homeComp.team), ea = espnTeamKey(awayComp.team);
  const homeOk = wantedHome.some(x => eh.includes(x));
  const awayOk = wantedAway.some(x => ea.includes(x));
  if(homeOk && awayOk)return {homeComp,awayComp};
  return null;
}
async function fetchEspnScore(m){
  const home = rawName(m.h), away = rawName(m.a);
  for(const dateKey of candidateEspnDates(m)){
    try{
      const board = await espnScoreboard(dateKey);
      for(const event of board.events){
        const status = event.status?.type || event.competitions?.[0]?.status?.type || {};
        if(!status.completed && String(status.state || "").toLowerCase() !== "post")continue;
        const matched = matchEspnEvent(event, home, away);
        if(!matched)continue;
        const hs = Number(matched.homeComp.score), as = Number(matched.awayComp.score);
        if(!Number.isFinite(hs) || !Number.isFinite(as))continue;
        const link = event.links?.find(l => l.rel?.includes("summary"))?.href || board.url;
        return {score:`${hs}-${as}`,source:"ESPN",url:link};
      }
    }catch(e){
      console.warn(`ESPN scoreboard failed ${dateKey}: ${e.message}`);
    }
  }
  return null;
}
function escapeRe(s){return String(s).replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\\ /g,"\\s+");}
async function getOfficialText(){
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try{
    const page = await browser.newPage({ userAgent: "Mozilla/5.0" });
    await page.goto(FIFA_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(12_000);
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
function parseScore(score){
  const parts = String(score || "").split(/[–-]/).map(x => Number.parseInt(x.trim(), 10));
  return parts.length === 2 && parts.every(Number.isFinite) ? parts : null;
}
function resultScore(entry){
  if(!entry)return "";
  if(typeof entry === "string")return entry;
  const status = String(entry.status || "").toLowerCase();
  return entry.score && ["final","done","full-time","ft"].includes(status) ? entry.score : "";
}
function todayRomeKey(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome"}).format(new Date());
}
function snapshotDaily(state){
  state.daily ||= {};
  const key = todayRomeKey();
  state.daily[key] = Object.values(state.users || {})
    .map(u => ({user:u.name,balance:u.balance}))
    .sort((a,b) => b.balance - a.balance);
}
function settleBets(state,matches){
  state.users ||= {};
  state.bets = Array.isArray(state.bets) ? state.bets : [];
  state.results ||= {};
  const matchById = Object.fromEntries(matches.map(m => [matchId(m), m]));
  let settled = 0;
  for(const bet of state.bets){
    if(bet.status !== "open")continue;
    const match = matchById[bet.mid];
    const score = resultScore(state.results[bet.mid]) || (match?.s || "");
    const parsed = parseScore(score);
    if(!parsed)continue;
    const user = state.users[bet.user];
    if(!user)continue;
    const [home,away] = parsed;
    const winningPick = home > away ? "h" : home < away ? "a" : "d";
    const won = bet.type === "1x2" ? bet.pick === winningPick : bet.pick === `${home}-${away}`;
    const now = Date.now();
    if(won){
      bet.payout = Math.round((bet.stake || 0) * (bet.odds || 0));
      user.balance = (user.balance || 0) + bet.payout;
      bet.status = "won";
    }else{
      bet.payout = 0;
      bet.status = "lost";
    }
    bet.settledAt = now;
    bet.updatedAt = now;
    user.updatedAt = now;
    settled += 1;
  }
  if(settled)snapshotDaily(state);
  return settled;
}

const matches = loadMatches();
const state = await loadState();
state.results ||= {};
state.resultSync ||= {};

const candidates = matches.filter(m => isCandidate(m) && (FORCE_ALL || !state.results[matchId(m)]));
console.log(`Candidate matches: ${candidates.length}`);
if(!candidates.length){
  const settled = settleBets(state,matches);
  state.resultSync = {source:"FIFA", mode:"post-match-only", lastCheckedAt:new Date().toISOString(), updated:0, settled};
  if(!DRY_RUN)await saveState(state);
  process.exit(0);
}

let officialText = "";
try{
  officialText = await getOfficialText();
}catch(e){
  console.warn(`FIFA page fetch failed: ${e.message}`);
}
let updated = 0;
for(const m of candidates){
  const home = rawName(m.h), away = rawName(m.a);
  let score = officialText ? scoreFromWindow(officialText, TEAM_EN[home] || home, TEAM_EN[away] || away) : null;
  let source = "FIFA";
  let sourceUrl = FIFA_URL;
  if(!score){
    const fallback = await fetchEspnScore(m) || await fetchFallbackScore(m);
    if(fallback){
      score = fallback.score;
      source = `FIFA fallback: ${fallback.source}`;
      sourceUrl = fallback.url;
    }
  }
  if(!score){
    console.log(`No final score found: ${home} vs ${away}`);
    continue;
  }
  state.results[matchId(m)] = {
    score,
    status:"final",
    source,
    sourceUrl,
    updatedAt:new Date().toISOString()
  };
  updated += 1;
  console.log(`Final: ${home} ${score} ${away}`);
}
const settled = settleBets(state,matches);
state.resultSync = {source:"FIFA", mode:"post-match-only", lastCheckedAt:new Date().toISOString(), updated, settled};
if(DRY_RUN){
  console.log("DRY_RUN=1, not writing Supabase");
}else{
  await saveState(state);
  console.log(`Supabase updated. New results: ${updated}; settled bets: ${settled}`);
}
