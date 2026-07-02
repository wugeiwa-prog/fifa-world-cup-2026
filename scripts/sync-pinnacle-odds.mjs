import fs from "node:fs";
import {makeClient} from "./supabase-state.mjs";

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
const ESPN_ODDS_BACKUP = process.env.ESPN_ODDS_BACKUP !== "0";
const SCORE_ODDS_SYNC = process.env.SCORE_ODDS_SYNC !== "0";
const SPORTSGAMBLER_SCORE_BACKUP = process.env.SPORTSGAMBLER_SCORE_BACKUP !== "0";
const SCORE_GRID = Number(process.env.SCORE_GRID || 7);
const POST_KICKOFF_ODDS_GRACE_MINUTES = Number(process.env.POST_KICKOFF_ODDS_GRACE_MINUTES || 30);
const HIGH_FREQ_LOOKAHEAD_MINUTES = Number(process.env.HIGH_FREQ_LOOKAHEAD_MINUTES || 90);
const HIGH_FREQ_MISSING_RATIO = Number(process.env.HIGH_FREQ_MISSING_RATIO || 0.8);
const HIGH_FREQ_CADENCE_MINUTES = Number(process.env.HIGH_FREQ_CADENCE_MINUTES || 10);

const PINNACLE_MATCHUPS_URLS = [
  "https://www.pinnacle.com/en/soccer/fifa-world-cup/matchups/",
  "https://www.pinnacle.bet/en/soccer/fifa-world-cup/matchups/"
];
const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
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
  return String(name).replace(/^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u{E0060}-\u{E007F}\s]+/u,"").trim();
}
function matchId(m){return `${m.d}#${m.t}#${rawName(m.h)}#${rawName(m.a)}`;}
function oddsKey(m){return `${rawName(m.h)}-${rawName(m.a)}`;}
function loadMatches(){
  const html = fs.readFileSync("world-cup-2026-schedule.html","utf8");
  const block = html.match(/const RAW_MATCHES\s*=\s*\[([\s\S]*?)\]\s*;\s*const GROUPS=/);
  if(!block)throw new Error("RAW_MATCHES block not found");
  return Function(`"use strict";return ([${block[1]}]);`)();
}
function romeKickoffUtc(m){
  const [mo,dd] = m.d.split("-").map(Number);
  const [hh,mm] = m.t.split(":").map(Number);
  return new Date(Date.UTC(2026, mo - 1, dd, hh - 2, mm));
}
function romeDateKey(date = new Date()){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome"}).format(date);
}
function addDays(dateStr, days){
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0,10);
}
function previousDay(dateStr){
  return addDays(dateStr, -1);
}
function matchDateKey(m){
  return `2026-${m.d}`;
}
function inBetWindow(m, now = new Date()){
  const today = romeDateKey(now);
  return [today, addDays(today,1)].includes(matchDateKey(m));
}
function isOddsCandidate(m, now = new Date()){
  if(m.s && !FORCE_ALL)return false;
  const home = rawName(m.h), away = rawName(m.a);
  if(!TEAM_EN[home] || !TEAM_EN[away])return false;
  if(!FORCE_ALL && !inBetWindow(m, now))return false;
  if(!PINNACLE_URLS[matchId(m)] && !ALLOW_MATCHUPS_PARSE && !ESPN_ODDS_BACKUP)return false;
  const kick = romeKickoffUtc(m).getTime();
  const graceHours = Math.max(0, POST_KICKOFF_ODDS_GRACE_MINUTES) / 60;
  const diffHours = (kick - now.getTime()) / 3_600_000;
  return FORCE_ALL || (diffHours > -graceHours && diffHours <= LOOKAHEAD_HOURS);
}
function syncCadenceMinutes(candidates, now = new Date(), health = null){
  if(!candidates.length)return {minutes:360, tier:"no-odds-candidate"};
  const nextMinutes = Math.min(...candidates.map(m => (romeKickoffUtc(m).getTime() - now.getTime()) / 60_000));
  if(health?.widespreadMissing && nextMinutes <= HIGH_FREQ_LOOKAHEAD_MINUTES){
    return {minutes:HIGH_FREQ_CADENCE_MINUTES, tier:"near-kickoff-widespread-missing"};
  }
  const nextHours = nextMinutes / 60;
  if(nextHours <= 6)return {minutes:60, tier:"kickoff-within-6h"};
  if(nextHours <= 24)return {minutes:120, tier:"matchday-minus-1"};
  return {minutes:360, tier:"normal"};
}
function hasUsableBookOdds(state, m){
  const o = state?.odds?.[matchId(m)] || state?.odds?.[oddsKey(m)];
  return Number(o?.h) > 1 && Number(o?.d) > 1 && Number(o?.a) > 1;
}
function hasUsableScoreOdds(state, m){
  if(!SCORE_ODDS_SYNC)return true;
  const o = state?.scoreOdds?.[matchId(m)] || state?.scoreOdds?.[oddsKey(m)];
  return Object.values(o?.scores || o?.prices || o?.correctScores || {}).filter(v => Number(v) > 1).length >= 4;
}
function oddsHealth(state, candidates){
  const checked = candidates.length;
  const bookMissing = candidates.filter(m => !hasUsableBookOdds(state, m)).length;
  const scoreMissing = candidates.filter(m => !hasUsableScoreOdds(state, m)).length;
  const ratio = n => checked ? n / checked : 0;
  return {
    checked,
    bookMissing,
    scoreMissing,
    bookMissingRatio:ratio(bookMissing),
    scoreMissingRatio:ratio(scoreMissing),
    widespreadMissing:checked > 0 &&
      ratio(bookMissing) >= HIGH_FREQ_MISSING_RATIO &&
      ratio(scoreMissing) >= HIGH_FREQ_MISSING_RATIO
  };
}
function missingSnapshotMatches(state, candidates){
  return candidates.filter(m => !hasUsableBookOdds(state, m) || !hasUsableScoreOdds(state, m));
}
function shouldFetchOdds(state, candidates, now = new Date()){
  const health = oddsHealth(state, candidates);
  const cadence = syncCadenceMinutes(candidates, now, health);
  if(FORCE_SYNC)return {...cadence, shouldFetch:true, reason:"forced"};
  if(!candidates.length)return {...cadence, shouldFetch:false, reason:"no odds candidate in lookahead window"};
  const missing = missingSnapshotMatches(state, candidates);
  const last = Date.parse(state?.oddsSync?.lastCheckedAt || state?.oddsSync?.lastAttemptAt || "") || 0;
  const elapsedMinutes = (now.getTime() - last) / 60_000;
  if(missing.length && !last)return {...cadence, ...health, shouldFetch:true, reason:"missing odds snapshot and no previous odds sync", missingSnapshots:missing.length};
  if(missing.length && elapsedMinutes >= cadence.minutes)return {...cadence, ...health, shouldFetch:true, reason:`missing odds snapshot for ${missing.length} match(es), elapsed ${Math.floor(elapsedMinutes)}m >= ${cadence.minutes}m`, missingSnapshots:missing.length};
  if(missing.length)return {...cadence, ...health, shouldFetch:false, reason:`missing odds snapshot for ${missing.length} match(es), elapsed ${Math.floor(elapsedMinutes)}m < ${cadence.minutes}m`, missingSnapshots:missing.length};
  if(!last)return {...cadence, ...health, shouldFetch:true, reason:"no previous odds sync"};
  if(elapsedMinutes >= cadence.minutes)return {...cadence, shouldFetch:true, reason:`elapsed ${Math.floor(elapsedMinutes)}m >= ${cadence.minutes}m`};
  return {...cadence, ...health, shouldFetch:false, reason:`elapsed ${Math.floor(elapsedMinutes)}m < ${cadence.minutes}m`};
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
  if(zh === "科特迪瓦")names.push("Ivory Coast", "Cote d Ivoire");
  if(zh === "佛得角")names.push("Cape Verde", "Cabo Verde");
  return [...new Set(names.map(norm))];
}
function numericOdds(values){
  return values.map(Number).filter(x => Number.isFinite(x) && x >= 1.01 && x <= 80);
}
function americanToDecimal(value){
  const n = Number(String(value ?? "").replace(/[^\d+-]/g,""));
  if(!Number.isFinite(n) || n === 0)return null;
  return Math.round((n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n)) * 1000) / 1000;
}
function ymd(date){
  return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,"0")}${String(date.getUTCDate()).padStart(2,"0")}`;
}
function candidateEspnDates(matches){
  const dates = new Set();
  for(const m of matches){
    const kick = romeKickoffUtc(m);
    dates.add(ymd(kick));
    dates.add(ymd(new Date(kick.getTime() - 6 * 60 * 60_000)));
    dates.add(ymd(new Date(kick.getTime() + 6 * 60 * 60_000)));
  }
  return [...dates].sort();
}
function namesMatch(zh, espnTeam){
  const hay = norm([
    espnTeam?.displayName,
    espnTeam?.shortDisplayName,
    espnTeam?.name,
    espnTeam?.abbreviation
  ].filter(Boolean).join(" "));
  return candidateNames(zh).some(name => hay.includes(name));
}
function oddsValue(side){
  return americanToDecimal(side?.close?.odds ?? side?.open?.odds ?? side?.moneyLine ?? side?.odds);
}
function parseEspnEventOdds(event,m){
  const comp = event?.competitions?.[0];
  const market = (comp?.odds || []).filter(Boolean).find(o => o.moneyline);
  if(!comp || !market)return null;
  const competitors = comp.competitors || [];
  const espnHome = competitors.find(c => c.homeAway === "home")?.team;
  const espnAway = competitors.find(c => c.homeAway === "away")?.team;
  const homeName = rawName(m.h), awayName = rawName(m.a);
  const hasTeams =
    ((namesMatch(homeName,espnHome) && namesMatch(awayName,espnAway)) ||
     (namesMatch(homeName,espnAway) && namesMatch(awayName,espnHome)));
  if(!hasTeams)return null;
  const eventTime = Date.parse(event.date || comp.date || "");
  if(Number.isFinite(eventTime)){
    const diffHours = Math.abs(eventTime - romeKickoffUtc(m).getTime()) / 3_600_000;
    if(diffHours > 4)return null;
  }
  const homeSide = namesMatch(homeName,espnHome) ? market.moneyline.home : market.moneyline.away;
  const awaySide = namesMatch(awayName,espnAway) ? market.moneyline.away : market.moneyline.home;
  const h = oddsValue(homeSide);
  const d = oddsValue(market.moneyline.draw || market.drawOdds);
  const a = oddsValue(awaySide);
  if(!(h > 1 && d > 1 && a > 1))return null;
  return {
    h,d,a,
    source:`ESPN/DraftKings`,
    url:event.links?.[0]?.href || ESPN_SCOREBOARD_URL,
    market:"1X2"
  };
}
async function loadEspnOdds(matches){
  if(!ESPN_ODDS_BACKUP || !matches.length)return new Map();
  const byMid = new Map();
  const dates = candidateEspnDates(matches);
  for(const date of dates){
    const url = `${ESPN_SCOREBOARD_URL}?dates=${date}&limit=100`;
    try{
      const res = await fetch(url,{headers:{"user-agent":"Mozilla/5.0 odds-sync"}});
      if(!res.ok)throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      for(const m of matches){
        if(byMid.has(matchId(m)))continue;
        for(const event of json.events || []){
          const found = parseEspnEventOdds(event,m);
          if(found){
            byMid.set(matchId(m), {...found, updatedAt:new Date().toISOString()});
            break;
          }
        }
      }
      console.log(`Fetched ESPN odds date: ${date}`);
    }catch(e){
      console.warn(`ESPN odds fetch failed: ${date}: ${e.message}`);
    }
  }
  return byMid;
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
function normalizeScoreKey(value){
  const m = String(value || "").trim().match(/^(\d+)\s*[-–:]\s*(\d+)$/);
  if(!m)return "";
  const h = Number(m[1]), a = Number(m[2]);
  if(!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h > SCORE_GRID || a > SCORE_GRID)return "";
  return `${h}-${a}`;
}
function setScorePrice(scores, key, price){
  const score = normalizeScoreKey(key);
  const odds = Number(price);
  if(score && odds > 1.01 && odds <= 500)scores[score] = Math.round(odds * 1000) / 1000;
}
function parseCorrectScoreOddsFromText(text, m){
  if(!SCORE_ODDS_SYNC)return null;
  const clean = String(text || "").replace(/\s+/g," ");
  const n = norm(clean);
  const markers = ["correct score","exact score","score betting","correct-score","比分"];
  const markerIndexes = markers.map(x => n.indexOf(x)).filter(i => i >= 0);
  if(!markerIndexes.length)return null;
  const home = rawName(m.h), away = rawName(m.a);
  if(!candidateNames(home).some(name => n.includes(name)) || !candidateNames(away).some(name => n.includes(name)))return null;
  const scores = {};
  for(const marker of markerIndexes){
    const start = Math.max(0, marker - 500);
    const window = clean.slice(start, Math.min(clean.length, marker + 8000));
    for(const rx of [
      /\b([0-7])\s*[-–:]\s*([0-7])\b[^\d.]{0,80}\b(\d{1,3}\.\d{2,3})\b/g,
      /\b(\d{1,3}\.\d{2,3})\b[^\d.]{0,80}\b([0-7])\s*[-–:]\s*([0-7])\b/g
    ]){
      let hit;
      while((hit = rx.exec(window))){
        if(hit[1].includes("."))setScorePrice(scores, `${hit[2]}-${hit[3]}`, hit[1]);
        else setScorePrice(scores, `${hit[1]}-${hit[2]}`, hit[3]);
      }
    }
  }
  if(Object.keys(scores).length < 4)return null;
  return {scores, market:"Correct Score"};
}
function teamSlug(zh){
  const map = {
    "美国":"usa",
    "英国":"england",
    "英格兰":"england",
    "韩国":"south-korea",
    "波黑":"bosnia",
    "刚果（金）":"dr-congo",
    "佛得角":"cape-verde",
    "伊朗":"iran",
    "科特迪瓦":"ivory-coast",
    "新西兰":"new-zealand",
    "沙特阿拉伯":"saudi-arabia"
  };
  const name = map[zh] || TEAM_EN[zh] || zh;
  return norm(name).replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}
function sportsgamblerUrls(m){
  const home = teamSlug(rawName(m.h));
  const away = teamSlug(rawName(m.a));
  const date = matchDateKey(m);
  return [
    `https://www.sportsgambler.com/betting-tips/football/${home}-vs-${away}-prediction-lineups-odds-${date}/`,
    `https://www.sportsgambler.com/betting-tips/football/${home}-vs-${away}-prediction-lineups-odds-${previousDay(date)}/`
  ];
}
function parseSportsgamblerScoreOdds(text, m){
  const clean = String(text || "").replace(/\s+/g," ");
  const marker = clean.toLowerCase().indexOf("latest correct score odds");
  if(marker < 0)return null;
  const window = clean.slice(marker, marker + 4500);
  const scores = {};
  for(const rx of [
    /\b([0-7])\s*[-–]\s*([0-7])\b[^\d.]{0,90}\b(\d{1,3}\.\d{2,3})\b/g,
    /\b([0-7])\s*[-–]\s*([0-7])\b[^\d.]{0,90}\b(\d{1,3}\.\d)\b/g
  ]){
    let hit;
    while((hit = rx.exec(window)))setScorePrice(scores, `${hit[1]}-${hit[2]}`, hit[3]);
  }
  if(Object.keys(scores).length < 4)return null;
  return {scores, market:"Correct Score"};
}
async function loadSportsgamblerScoreOdds(matches){
  if(!SPORTSGAMBLER_SCORE_BACKUP || !SCORE_ODDS_SYNC || !matches.length)return new Map();
  const byMid = new Map();
  for(const m of matches){
    for(const url of sportsgamblerUrls(m)){
      try{
        const res = await fetch(url,{headers:{"user-agent":"Mozilla/5.0 odds-sync"}});
        if(res.status === 404)continue;
        if(!res.ok)throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const text = html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ");
        const found = parseSportsgamblerScoreOdds(text, m);
        if(found){
          byMid.set(matchId(m), {...found, source:"SportsGambler/BetMGM", url, updatedAt:new Date().toISOString()});
          console.log(`SportsGambler correct-score odds: ${oddsKey(m)} ${Object.keys(found.scores).length} lines`);
          break;
        }
      }catch(e){
        console.warn(`SportsGambler score odds fetch failed: ${oddsKey(m)} ${url}: ${e.message}`);
      }
    }
  }
  return byMid;
}
async function loadPageTexts(urls){
  const texts = [];
  for(const url of urls){
    try{
      const res = await fetch(url,{headers:{"user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36"}});
      if(res.ok){
        const html = await res.text();
        if(html && html.length > 200){
          const text = html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ");
          texts.push({url,text});
          console.log(`Fetched Pinnacle html: ${url}`);
          continue;
        }
      }
    }catch(e){
      console.warn(`Pinnacle html fetch failed: ${url}: ${e.message}`);
    }
  }
  const remaining = urls.filter(url => !texts.some(t => t.url === url));
  if(!remaining.length)return texts;
  let chromium;
  try{
    ({ chromium } = await import("playwright"));
  }catch(e){
    console.warn(`Playwright not available: ${e.message}`);
    return texts;
  }
  const browser = await chromium.launch({ headless:true, args:["--disable-dev-shm-usage"] });
  try{
    for(const url of remaining){
      try{
        const page = await browser.newPage({ userAgent:"Mozilla/5.0" });
        await page.route("**/*", route => {
          const type = route.request().resourceType();
          return ["image","media","font"].includes(type) ? route.abort() : route.continue();
        });
        await page.goto(url,{ waitUntil:"commit", timeout:90_000 });
        await page.waitForTimeout(12_000);
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
const stateClient=makeClient({url:SUPABASE_URL,anonKey:SUPABASE_ANON_KEY,legacyTable:SUPABASE_TABLE,rowId:SUPABASE_ROW_ID});
const loadState=()=>stateClient.loadState();
const saveState=data=>stateClient.saveState(data);

const matches = loadMatches();
const candidates = matches.filter(m => isOddsCandidate(m));
console.log(`Bookmaker odds candidate matches: ${candidates.length}`);

const state = await loadState();
state.odds ||= {};
state.oddsSync ||= {};
state.scoreOdds ||= {};
state.scoreOddsSync ||= {};

const plan = shouldFetchOdds(state, candidates);
console.log(`Odds sync plan: ${plan.shouldFetch ? "fetch" : "skip"} (${plan.tier}, every ${plan.minutes}m, ${plan.reason})`);
setGithubOutput({
  should_fetch: plan.shouldFetch ? "true" : "false",
  tier: plan.tier,
  cadence_minutes: plan.minutes,
  reason: plan.reason,
  missing_snapshots: plan.missingSnapshots || 0,
  book_missing_ratio: plan.bookMissingRatio || 0,
  score_missing_ratio: plan.scoreMissingRatio || 0
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
      missingSnapshots:plan.missingSnapshots || 0,
      bookMissingRatio:plan.bookMissingRatio || 0,
      scoreMissingRatio:plan.scoreMissingRatio || 0,
      cadenceMinutes:plan.minutes,
      cadenceTier:plan.tier,
      skipReason:plan.reason,
      matchupsParse:ALLOW_MATCHUPS_PARSE,
      espnBackup:ESPN_ODDS_BACKUP,
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
  const espnOdds = await loadEspnOdds(candidates);
  const sportsgamblerScoreOdds = await loadSportsgamblerScoreOdds(candidates);
  let updated = 0;
  let pruned = 0;
  let espnUpdated = 0;
  let pinnacleUpdated = 0;
  let scoreUpdated = 0;
  let scoreChecked = 0;
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
    const directPage = direct ? pageTexts.find(p => p.url === direct) : null;
    if(SCORE_ODDS_SYNC){
      scoreChecked += 1;
      const scoreOdds = directPage ? parseCorrectScoreOddsFromText(directPage.text, m) : null;
      if(scoreOdds){
        state.scoreOdds[matchId(m)] = {
          ...scoreOdds,
          source:"Pinnacle",
          url:directPage.url,
          updatedAt:checkedAt
        };
        scoreUpdated += 1;
        console.log(`Pinnacle correct-score odds: ${oddsKey(m)} ${Object.keys(scoreOdds.scores).length} lines`);
      }else if(sportsgamblerScoreOdds.has(matchId(m))){
        state.scoreOdds[matchId(m)] = {
          ...sportsgamblerScoreOdds.get(matchId(m)),
          updatedAt:checkedAt
        };
        scoreUpdated += 1;
      }else{
        warnings.push(`No correct-score odds parsed: ${oddsKey(m)}`);
      }
    }
    if(!found){
      const backup = espnOdds.get(matchId(m));
      if(backup){
        found = {...backup, updatedAt:checkedAt};
      }else{
        warnings.push(`No bookmaker 1X2 odds parsed: ${oddsKey(m)}`);
        continue;
      }
    }
    state.odds[matchId(m)] = found;
    updated += 1;
    if(found.source === "Pinnacle")pinnacleUpdated += 1;
    if(found.source?.includes("ESPN"))espnUpdated += 1;
    console.log(`${found.source} odds: ${oddsKey(m)} ${found.h}/${found.d}/${found.a}`);
  }

  state.oddsSync = {
    source:ESPN_ODDS_BACKUP ? "Pinnacle + ESPN/DraftKings" : "Pinnacle",
    mode:"pre-match-periodic",
    lastAttemptAt:checkedAt,
    lastCheckedAt:checkedAt,
    checked:candidates.length,
    missingSnapshots:plan.missingSnapshots || 0,
    bookMissingRatio:plan.bookMissingRatio || 0,
    scoreMissingRatio:plan.scoreMissingRatio || 0,
    updated,
    pinnacleUpdated,
    espnUpdated,
    pruned,
    cadenceMinutes:plan.minutes,
    cadenceTier:plan.tier,
    syncReason:plan.reason,
    matchupsParse:ALLOW_MATCHUPS_PARSE,
    espnBackup:ESPN_ODDS_BACKUP,
    lookaheadHours:LOOKAHEAD_HOURS,
    scoreOddsSync:SCORE_ODDS_SYNC,
    sportsgamblerScoreBackup:SPORTSGAMBLER_SCORE_BACKUP,
    scoreChecked,
    scoreUpdated,
    warnings:warnings.slice(0,20)
  };
  state.scoreOddsSync = {
    source:SPORTSGAMBLER_SCORE_BACKUP ? "Pinnacle + SportsGambler/BetMGM" : "Pinnacle",
    mode:"pre-match-correct-score",
    lastAttemptAt:checkedAt,
    lastCheckedAt:checkedAt,
    checked:scoreChecked,
    updated:scoreUpdated,
    directPagesOnly:false,
    sportsgamblerBackup:SPORTSGAMBLER_SCORE_BACKUP,
    scoreGrid:SCORE_GRID,
    note:"Correct-score odds prefer direct Pinnacle match pages and fall back to SportsGambler/BetMGM match pages.",
    warnings:warnings.filter(w => w.includes("correct-score")).slice(0,20)
  };

  if(DRY_RUN){
    console.log(JSON.stringify(state.oddsSync,null,2));
    console.log(JSON.stringify(state.scoreOddsSync,null,2));
    console.log("DRY_RUN=1, not writing Supabase");
  }else{
    await saveState(state);
    console.log(`Supabase odds sync complete. Updated odds: ${updated}`);
  }
}
