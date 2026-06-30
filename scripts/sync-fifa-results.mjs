import fs from "node:fs";
import {makeClient,normalizeBalances} from "./supabase-state.mjs";

const FIFA_URL = "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "wc2026_state";
const SUPABASE_ROW_ID = process.env.SUPABASE_ROW_ID || "global";
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE_ALL = process.env.FORCE_ALL === "1";
const PLAN_ONLY = process.env.RESULT_PLAN_ONLY === "1";
const LIVE_SCORE_SYNC = process.env.LIVE_SCORE_SYNC !== "0";
const FINAL_LOOKBACK_HOURS = Number(process.env.RESULT_FINAL_LOOKBACK_HOURS || 10);

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
function expectedFinalUtc(m){
  const delayMin = m.st === "group" ? 120 : 180;
  return new Date(romeKickoffUtc(m).getTime() + delayMin * 60_000);
}
function existingResultStatus(state,m){
  return String(state?.results?.[matchId(m)]?.status || "").toLowerCase();
}
function hasFinalResult(state,m){
  const r = state?.results?.[matchId(m)];
  const status = String(r?.status || "").toLowerCase();
  return Boolean(r?.score && ["final","done","full-time","ft"].includes(status));
}
function isLiveCandidate(m,state,now = new Date()){
  if(!LIVE_SCORE_SYNC && !FORCE_ALL)return false;
  if(!FORCE_ALL && (m.s || hasFinalResult(state,m)))return false;
  const kick = romeKickoffUtc(m).getTime();
  const end = expectedFinalUtc(m).getTime();
  return FORCE_ALL || (now.getTime() >= kick && now.getTime() < end);
}
function isFinalCandidate(m,state,now = new Date()){
  if(!FORCE_ALL && (m.s || hasFinalResult(state,m)))return false;
  const end = expectedFinalUtc(m).getTime();
  const max = end + FINAL_LOOKBACK_HOURS * 3_600_000;
  return FORCE_ALL || (now.getTime() >= end && now.getTime() <= max);
}
function setGithubOutput(values){
  const out = process.env.GITHUB_OUTPUT;
  if(!out)return;
  fs.appendFileSync(out, Object.entries(values).map(([k,v]) => `${k}=${String(v).replace(/\r?\n/g," ")}`).join("\n") + "\n");
}
function norm(s){
  return String(s||"")
    .normalize("NFD").replace(/\p{Diacritic}/gu,"")
    .replace(/Türkiye/g,"Turkiye")
    .replace(/Cote d'Ivoire/g,"Cote d Ivoire")
    .toLowerCase();
}
function makeResult(score, extra = {}){
  if(!score)return null;
  const penaltyScore = extra.penaltyScore || "";
  return {
    score,
    ...(penaltyScore ? {penaltyScore, displayScore:`${score}（点球 ${penaltyScore}）`} : {}),
    ...(extra.detail ? {detail:extra.detail} : {})
  };
}
function penaltyScoreFromText(text){
  const s = String(text || "");
  const patterns = [
    /\((?:penalties|pens|pen|pso|点球)[^\d]{0,18}(\d{1,2})\s*[-–:]\s*(\d{1,2})\)/i,
    /\((\d{1,2})\s*[-–:]\s*(\d{1,2})[^\)]{0,18}(?:penalties|pens|pen|pso|点球)\)/i,
    /(?:penalties|pens|penalty shootout|shootout|pso|点球)[^\d]{0,40}(\d{1,2})\s*[-–:]\s*(\d{1,2})/i
  ];
  for(const rx of patterns){
    const m = s.match(rx);
    if(m)return `${Number(m[1])}-${Number(m[2])}`;
  }
  return "";
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
  if(first)return makeResult(`${Number(first[1])}-${Number(first[2])}`,{penaltyScore:penaltyScoreFromText(win)});
  const second = win.match(patterns[1]);
  if(second)return makeResult(`${Number(second[2])}-${Number(second[1])}`,{penaltyScore:penaltyScoreFromText(win)});
  return null;
}
function scoreFromCanadaSoccer(html){
  if(!/Full Time/i.test(html))return null;
  const m = html.match(/id=["']match-score["'][^>]*>\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*</i)
    || html.match(/<div class=["']score["'][\s\S]{0,260}?(\d{1,2})\s*[-–]\s*(\d{1,2})[\s\S]{0,260}?Full Time/i);
  return m ? makeResult(`${Number(m[1])}-${Number(m[2])}`,{penaltyScore:penaltyScoreFromText(html)}) : null;
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
      const result = source.parser === "canada-soccer"
        ? scoreFromCanadaSoccer(html)
        : scoreFromGenericHtml(html, TEAM_EN[home] || home, TEAM_EN[away] || away);
      if(result)return {...result, source:source.name, url:source.url};
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
  const found = await fetchEspnMatch(m,{allowLive:false});
  return found?.status === "final" ? found : null;
}
function numberField(obj, keys){
  for(const key of keys){
    const n = Number(obj?.[key]);
    if(Number.isFinite(n))return n;
  }
  return null;
}
function espnPenaltyScore(event, matched, status){
  const keys = ["shootoutScore","penaltyScore","penalties","penaltyShootoutScore","psoScore"];
  const hp = numberField(matched.homeComp, keys);
  const ap = numberField(matched.awayComp, keys);
  if(hp != null && ap != null)return `${hp}-${ap}`;
  const text = [
    status?.shortDetail,
    status?.detail,
    status?.description,
    event?.note,
    event?.competitions?.[0]?.note
  ].filter(Boolean).join(" ");
  return penaltyScoreFromText(text);
}
async function fetchEspnMatch(m,{allowLive = true} = {}){
  const home = rawName(m.h), away = rawName(m.a);
  for(const dateKey of candidateEspnDates(m)){
    try{
      const board = await espnScoreboard(dateKey);
      for(const event of board.events){
        const status = event.status?.type || event.competitions?.[0]?.status?.type || {};
        const matched = matchEspnEvent(event, home, away);
        if(!matched)continue;
        const hs = Number(matched.homeComp.score), as = Number(matched.awayComp.score);
        if(!Number.isFinite(hs) || !Number.isFinite(as))continue;
        const state = String(status.state || "").toLowerCase();
        const completed = Boolean(status.completed || state === "post");
        const live = !completed && (state === "in" || /progress|halftime|live/i.test(status.description || status.detail || ""));
        if(!completed && !(allowLive && live))continue;
        const link = event.links?.find(l => l.rel?.includes("summary"))?.href || board.url;
        const score = `${hs}-${as}`;
        const penaltyScore = completed ? espnPenaltyScore(event, matched, status) : "";
        return {
          score,
          ...(penaltyScore ? {penaltyScore, displayScore:`${score}（点球 ${penaltyScore}）`} : {}),
          status:completed ? "final" : "live",
          source:completed ? "ESPN" : "ESPN live",
          url:link,
          detail:status.shortDetail || status.detail || status.description || ""
        };
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
const stateClient=makeClient({url:SUPABASE_URL,anonKey:SUPABASE_ANON_KEY,legacyTable:SUPABASE_TABLE,rowId:SUPABASE_ROW_ID});
const loadState=()=>stateClient.loadState();
const saveState=data=>stateClient.saveState(data);
function parseScore(score){
  const m = String(score || "").match(/(\d{1,2})\s*[-–:]\s*(\d{1,2})/);
  const parts = m ? [Number(m[1]),Number(m[2])] : [];
  return parts.length === 2 && parts.every(Number.isFinite) ? parts : null;
}
function resultScore(entry){
  if(!entry)return "";
  if(typeof entry === "string")return parseScore(entry)?.join("-") || "";
  const status = String(entry.status || "").toLowerCase();
  return entry.score && ["final","done","full-time","ft"].includes(status) ? (parseScore(entry.score)?.join("-") || "") : "";
}
function todayRomeKey(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome"}).format(new Date());
}
function snapshotDaily(state){
  normalizeBalances(state);
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
  if(settled){normalizeBalances(state);snapshotDaily(state);}
  return settled;
}

const matches = loadMatches();
const state = await loadState();
state.results ||= {};
state.resultSync ||= {};

const liveCandidates = matches.filter(m => isLiveCandidate(m,state));
const finalCandidates = matches.filter(m => isFinalCandidate(m,state));
const shouldFetch = Boolean(FORCE_ALL || liveCandidates.length || finalCandidates.length);
console.log(`Live score candidates: ${liveCandidates.length}`);
console.log(`Final result candidates: ${finalCandidates.length}`);
setGithubOutput({
  should_fetch: shouldFetch ? "true" : "false",
  live_candidates: liveCandidates.length,
  final_candidates: finalCandidates.length,
  need_playwright: finalCandidates.length ? "true" : "false"
});
if(PLAN_ONLY){
  console.log(JSON.stringify({shouldFetch,liveCandidates:liveCandidates.length,finalCandidates:finalCandidates.length},null,2));
  process.exit(0);
}
if(!shouldFetch){
  const settled = settleBets(state,matches);
  if(settled && !DRY_RUN){
    state.resultSync = {...state.resultSync, source:"FIFA + ESPN", mode:"smart-live-and-final", lastCheckedAt:new Date().toISOString(), updated:0, liveUpdated:0, finalUpdated:0, settled};
    await saveState(state);
  }
  process.exit(0);
}

let officialText = "";
if(finalCandidates.length){
  try{
    officialText = await getOfficialText();
  }catch(e){
    console.warn(`FIFA page fetch failed: ${e.message}`);
  }
}
let liveUpdated = 0;
let finalUpdated = 0;
let unchanged = 0;
const checkedAt = new Date().toISOString();
for(const m of liveCandidates){
  const home = rawName(m.h), away = rawName(m.a);
  const live = await fetchEspnMatch(m,{allowLive:true});
  if(!live || live.status !== "live"){
    console.log(`No live score found: ${home} vs ${away}`);
    continue;
  }
  const old = state.results[matchId(m)];
  if(old?.score === live.score && String(old?.status || "").toLowerCase() === "live"){
    unchanged += 1;
    continue;
  }
  state.results[matchId(m)] = {
    score:live.score,
    ...(live.displayScore ? {displayScore:live.displayScore} : {}),
    ...(live.penaltyScore ? {penaltyScore:live.penaltyScore} : {}),
    status:"live",
    source:live.source,
    sourceUrl:live.url,
    detail:live.detail,
    updatedAt:checkedAt
  };
  liveUpdated += 1;
  console.log(`Live: ${home} ${live.score} ${away} ${live.detail || ""}`.trim());
}
for(const m of finalCandidates){
  const home = rawName(m.h), away = rawName(m.a);
  let result = officialText ? scoreFromWindow(officialText, TEAM_EN[home] || home, TEAM_EN[away] || away) : null;
  let source = "FIFA";
  let sourceUrl = FIFA_URL;
  if(!result){
    const fallback = await fetchEspnScore(m) || await fetchFallbackScore(m);
    if(fallback){
      result = fallback;
      source = `FIFA fallback: ${fallback.source}`;
      sourceUrl = fallback.url;
    }
  }
  if(!result?.score){
    console.log(`No final score found: ${home} vs ${away}`);
    continue;
  }
  state.results[matchId(m)] = {
    score:result.score,
    ...(result.displayScore ? {displayScore:result.displayScore} : {}),
    ...(result.penaltyScore ? {penaltyScore:result.penaltyScore} : {}),
    status:"final",
    source,
    sourceUrl,
    updatedAt:checkedAt
  };
  finalUpdated += 1;
  console.log(`Final: ${home} ${result.displayScore || result.score} ${away}`);
}
const settled = settleBets(state,matches);
state.resultSync = {source:"FIFA + ESPN", mode:"smart-live-and-final", lastCheckedAt:checkedAt, updated:liveUpdated + finalUpdated, liveUpdated, finalUpdated, unchanged, settled, liveCandidates:liveCandidates.length, finalCandidates:finalCandidates.length};
if(DRY_RUN){
  console.log("DRY_RUN=1, not writing Supabase");
}else{
  await saveState(state);
  console.log(`Supabase updated. Live scores: ${liveUpdated}; final results: ${finalUpdated}; settled bets: ${settled}`);
}
