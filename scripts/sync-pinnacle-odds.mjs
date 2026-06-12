import fs from "node:fs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "wc2026_state";
const SUPABASE_ROW_ID = process.env.SUPABASE_ROW_ID || "global";
const DRY_RUN = process.env.DRY_RUN === "1";
const PLAN_ONLY = process.env.ODDS_PLAN_ONLY === "1";
const LOOKAHEAD_HOURS = Number(process.env.ODDS_LOOKAHEAD_HOURS || 48);
const FORCE_ALL = process.env.FORCE_ALL === "1";
const FORCE_SYNC = process.env.ODDS_FORCE_SYNC === "1" || process.env.ODDS_FORCE_SYNC === "true" || FORCE_ALL;
const ALLOW_MATCHUPS_PARSE = process.env.PINNACLE_ALLOW_MATCHUPS_PARSE === "1";

const PINNACLE_MATCHUPS_URLS = [
  "https://www.pinnacle.com/en/soccer/fifa-world-cup/matchups/",
  "https://www.pinnacle.bet/en/soccer/fifa-world-cup/matchups/"
];
const PINNACLE_URLS = {
  "06-12#21:00#加拿大#波黑":"https://www.pinnacle.com/en/soccer/fifa-world-cup/canada-vs-bosnia-and-herzegovina/1627278050/",
  "06-13#03:00#美国#巴拉圭":"https://www.pinnacle.bet/en/soccer/fifa-world-cup/usa-vs-paraguay/1620858178/",
  "06-13#21:00#卡塔尔#瑞士":"https://www.pinnacle.com/en/soccer/fifa-world-cup/qatar-vs-switzerland/1620858176/"
};
const TEAM_EN = {
  "墨西哥":"Mexico","南非":"South Africa","韩国":"Korea Republic","捷克":"Czechia","加拿大":"Canada","波黑":"Bosnia and Herzegovina",
  "卡塔尔":"Qatar","瑞士":"Switzerland","巴西":"Brazil","摩洛哥":"Morocco","海地":"Haiti","苏格兰":"Scotland",
  "美国":"USA","巴拉圭":"Paraguay","澳大利亚":"Australia","土耳其":"Turkiye","德国":"Germany","库拉索":"Curacao",
  "科特迪瓦":"Cote d'Ivoire","厄瓜多尔":"Ecuador","荷兰":"Netherlands","日本":"Japan","瑞典":"Sweden","突尼斯":"Tunisia",
  "比利时":"Belgium","埃及":"Egypt","伊朗":"IR Iran","新西兰":"New Zealand","西班牙":"Spain","佛得角":"Cabo Verde",
  "沙特阿拉伯":"Saudi Arabia","乌拉圭":"Uruguay","法国":"France","塞内加尔":"Senegal","伊拉克":"Iraq","挪威":"Norway",
  "阿根廷":"Argentina","阿尔及利亚":"Algeria","奥地利":"Austria","约旦":"Jordan","葡萄牙":"Portugal","刚果（金）":"Congo DR",
  "乌兹别克斯坦":"Uzbekistan","哥伦比亚":"Colombia","英格兰":"England","克罗地亚":"Croatia","加纳":"Ghana","巴拿马":"Panama"
};

function rawName(name){
  return String(name).replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\s]+/u,"").trim();
}
function matchId(m){return `${m.d}#${m.t}#${rawName(m.h)}#${rawName(m.a)}`;}
function oddsKey(m){return `${rawName(m.h)}-${rawName(m.a)}`;}
function loadMatches(){
  const html = fs.readFileSync("world-cup-2026-schedule.html","utf8");
  const block = html.match(/const RAW_MATCHES=\[([\s\S]*?)\];\n\nconst GROUPS=/);
  if(!block)throw new Error("RAW_MATCHES block not found");
  return Function(`"use strict";return ([${block[1]}]);`)();
}
function romeKickoffUtc(m){
  const [mo,dd] = m.d.split("-").map(Number);
  const [hh,mm] = m.t.split(":").map(Number);
  return new Date(Date.UTC(2026, mo - 1, dd, hh - 2, mm));
}
function isOddsCandidate(m, now = new Date()){
  if(m.s && !FORCE_ALL)return false;
  if(!PINNACLE_URLS[matchId(m)] && !ALLOW_MATCHUPS_PARSE)return false;
  const kick = romeKickoffUtc(m).getTime();
  const diffHours = (kick - now.getTime()) / 3_600_000;
  return FORCE_ALL || (diffHours > 0 && diffHours <= LOOKAHEAD_HOURS);
}
function syncCadenceMinutes(candidates, now = new Date()){
  if(!candidates.length)return {minutes:360, tier:"no-direct-match"};
  const nextHours = Math.min(...candidates.map(m => (romeKickoffUtc(m).getTime() - now.getTime()) / 3_600_000));
  if(nextHours <= 6)return {minutes:60, tier:"kickoff-within-6h"};
  if(nextHours <= 24)return {minutes:120, tier:"matchday-minus-1"};
  return {minutes:360, tier:"normal"};
}
function shouldFetchOdds(state, candidates, now = new Date()){
  const cadence = syncCadenceMinutes(candidates, now);
  if(FORCE_SYNC)return {...cadence, shouldFetch:true, reason:"forced"};
  if(!candidates.length)return {...cadence, shouldFetch:false, reason:"no direct Pinnacle URL in lookahead window"};
  const last = Date.parse(state?.oddsSync?.lastCheckedAt || state?.oddsSync?.lastAttemptAt || "") || 0;
  if(!last)return {...cadence, shouldFetch:true, reason:"no previous odds sync"};
  const elapsedMinutes = (now.getTime() - last) / 60_000;
  if(elapsedMinutes >= cadence.minutes)return {...cadence, shouldFetch:true, reason:`elapsed ${Math.floor(elapsedMinutes)}m >= ${cadence.minutes}m`};
  return {...cadence, shouldFetch:false, reason:`elapsed ${Math.floor(elapsedMinutes)}m < ${cadence.minutes}m`};
}
function setGithubOutput(values){
  const out = process.env.GITHUB_OUTPUT;
  if(!out)return;
  fs.appendFileSync(out, Object.entries(values).map(([k,v]) => `${k}=${String(v).replace(/\r?\n/g," ")}`).join("\n") + "\n");
}
function norm(s){
  return String(s || "")
    .normalize("NFD").replace(/\p{Diacritic}/gu,"")
    .replace(/Türkiye/g,"Turkiye")
    .replace(/Côte/g,"Cote")
    .toLowerCase();
}
function candidateNames(zh){
  const en = TEAM_EN[zh] || zh;
  const names = [en, zh];
  if(zh === "美国")names.push("United States", "USA");
  if(zh === "韩国")names.push("South Korea", "Korea Republic");
  if(zh === "波黑")names.push("Bosnia", "Bosnia-Herzegovina");
  if(zh === "刚果（金）")names.push("DR Congo", "Congo DR");
  return [...new Set(names.map(norm))];
}
function numericOdds(values){
  return values.map(Number).filter(x => Number.isFinite(x) && x >= 1.01 && x <= 80);
}
function parseOddsFromText(text, m){
  const clean = String(text || "").replace(/\s+/g," ");
  const n = norm(clean);
  const home = rawName(m.h), away = rawName(m.a);
  const homeHits = candidateNames(home).map(x => n.indexOf(x)).filter(i => i >= 0);
  const awayHits = candidateNames(away).map(x => n.indexOf(x)).filter(i => i >= 0);
  if(!homeHits.length || !awayHits.length)return null;
  const pairs = homeHits.flatMap(h => awayHits.map(a => [h,a])).sort((a,b)=>Math.abs(a[0]-a[1])-Math.abs(b[0]-b[1]));
  for(const [hi,ai] of pairs){
    if(Math.abs(hi-ai) > 2200)continue;
    const start = Math.max(0, Math.min(hi,ai) - 300);
    const end = Math.min(clean.length, Math.max(hi,ai) + 1600);
    const window = clean.slice(start,end);
    const moneyLine = window.match(/(?:money\s*line|match\s*winner|1x2|full\s*time\s*result)[\s\S]{0,900}?((?:\b\d{1,2}\.\d{2,3}\b[\s\S]{0,80}){3})/i);
    const odds = numericOdds((moneyLine?.[1] || window).match(/\b\d{1,2}\.\d{2,3}\b/g) || []);
    if(odds.length >= 3)return {h:odds[0], d:odds[1], a:odds[2]};
  }
  return null;
}
async function loadPageTexts(urls){
  const texts = [];
  let chromium;
  try{
    ({ chromium } = await import("playwright"));
  }catch(e){
    console.warn(`Playwright not available: ${e.message}`);
    return texts;
  }
  const browser = await chromium.launch({ headless:true });
  try{
    for(const url of urls){
      try{
        const page = await browser.newPage({ userAgent:"Mozilla/5.0" });
        await page.goto(url,{ waitUntil:"domcontentloaded", timeout:45_000 });
        await page.waitForTimeout(8_000);
        texts.push({url,text:await page.evaluate(() => document.body.innerText)});
        await page.close();
        console.log(`Fetched Pinnacle page: ${url}`);
      }catch(e){
        console.warn(`Pinnacle fetch failed: ${url}: ${e.message}`);
      }
    }
  }finally{
    await browser.close();
  }
  return texts;
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
  return Array.isArray(rows) && rows[0]?.data ? rows[0].data : {users:{},bets:[],daily:{},results:{},resultSync:{},odds:{},oddsSync:{}};
}
async function saveState(data){
  const updated_at = new Date().toISOString();
  await remoteFetch("POST",SUPABASE_TABLE,{id:SUPABASE_ROW_ID,data,updated_at});
}

const matches = loadMatches();
const candidates = matches.filter(m => isOddsCandidate(m));
console.log(`Pinnacle odds candidate matches: ${candidates.length}`);

const state = await loadState();
state.odds ||= {};
state.oddsSync ||= {};

const plan = shouldFetchOdds(state, candidates);
console.log(`Odds sync plan: ${plan.shouldFetch ? "fetch" : "skip"} (${plan.tier}, every ${plan.minutes}m, ${plan.reason})`);
setGithubOutput({
  should_fetch: plan.shouldFetch ? "true" : "false",
  tier: plan.tier,
  cadence_minutes: plan.minutes,
  reason: plan.reason
});
if(PLAN_ONLY || !plan.shouldFetch){
  if(DRY_RUN || PLAN_ONLY){
    console.log(JSON.stringify({checked:candidates.length,...plan},null,2));
  }else{
    state.oddsSync = {
      ...state.oddsSync,
      source:"Pinnacle",
      mode:"pre-match-periodic",
      lastSkippedAt:new Date().toISOString(),
      checked:candidates.length,
      cadenceMinutes:plan.minutes,
      cadenceTier:plan.tier,
      skipReason:plan.reason,
      matchupsParse:ALLOW_MATCHUPS_PARSE,
      lookaheadHours:LOOKAHEAD_HOURS
    };
    await saveState(state);
  }
}else{
  const urls = [...new Set([
    ...(ALLOW_MATCHUPS_PARSE ? PINNACLE_MATCHUPS_URLS : []),
    ...candidates.map(m => PINNACLE_URLS[matchId(m)]).filter(Boolean)
  ])];
  const pageTexts = await loadPageTexts(urls);
  let updated = 0;
  let pruned = 0;
  const warnings = [];
  const checkedAt = new Date().toISOString();

  if(!ALLOW_MATCHUPS_PARSE){
    for(const [id,entry] of Object.entries(state.odds)){
      if(String(entry?.url || "").includes("/matchups/")){
        delete state.odds[id];
        pruned += 1;
      }
    }
  }

  for(const m of candidates){
    let found = null;
    const direct = PINNACLE_URLS[matchId(m)];
    const sources = direct
      ? pageTexts.filter(p => p.url === direct || (ALLOW_MATCHUPS_PARSE && !PINNACLE_URLS[matchId(m)]))
      : (ALLOW_MATCHUPS_PARSE ? pageTexts : []);
    for(const page of sources){
      const odds = parseOddsFromText(page.text, m);
      if(odds){
        found = {...odds, source:"Pinnacle", url:page.url, updatedAt:checkedAt, market:"1X2"};
        break;
      }
    }
    if(!found){
      warnings.push(`No Pinnacle 1X2 odds parsed: ${oddsKey(m)}`);
      continue;
    }
    state.odds[matchId(m)] = found;
    updated += 1;
    console.log(`Pinnacle odds: ${oddsKey(m)} ${found.h}/${found.d}/${found.a}`);
  }

  state.oddsSync = {
    source:"Pinnacle",
    mode:"pre-match-periodic",
    lastAttemptAt:checkedAt,
    lastCheckedAt:checkedAt,
    checked:candidates.length,
    updated,
    pruned,
    cadenceMinutes:plan.minutes,
    cadenceTier:plan.tier,
    syncReason:plan.reason,
    matchupsParse:ALLOW_MATCHUPS_PARSE,
    lookaheadHours:LOOKAHEAD_HOURS,
    warnings:warnings.slice(0,20)
  };

  if(DRY_RUN){
    console.log(JSON.stringify(state.oddsSync,null,2));
    console.log("DRY_RUN=1, not writing Supabase");
  }else{
    await saveState(state);
    console.log(`Supabase odds sync complete. Updated odds: ${updated}`);
  }
}
