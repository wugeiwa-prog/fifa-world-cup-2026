import {mkdir, writeFile} from "node:fs/promises";
import {makeClient, normalizeBalances} from "./supabase-state.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const APPLY = process.env.APPLY === "1";

const client = makeClient({url:SUPABASE_URL, anonKey:SUPABASE_ANON_KEY});
const base = SUPABASE_URL.replace(/\/$/,"");
const headers = {apikey:SUPABASE_ANON_KEY, Authorization:`Bearer ${SUPABASE_ANON_KEY}`};

async function readTable(table){
  const res = await fetch(`${base}/rest/v1/${table}?select=*`, {headers});
  if(!res.ok)throw new Error(`Backup read ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}
function todayRomeKey(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Rome"}).format(new Date());
}
function snapshotDaily(state){
  const key = todayRomeKey();
  state.daily ||= {};
  state.daily[key] = Object.values(state.users || {})
    .map(u => ({user:u.name,balance:u.balance}))
    .sort((a,b) => b.balance - a.balance);
}

const [rawUsers, rawBets] = await Promise.all([
  readTable("wc2026_users"),
  readTable("wc2026_bets")
]);

await mkdir(".backups", {recursive:true});
const stamp = new Date().toISOString().replace(/[:.]/g,"-");
const backupPath = `.backups/betting-balance-repair-${stamp}.json`;
await writeFile(backupPath, JSON.stringify({createdAt:new Date().toISOString(), users:rawUsers, bets:rawBets}, null, 2), "utf8");

const state = await client.loadState();
const before = Object.fromEntries(rawUsers.map(u => [u.name, Number(u.balance) || 0]));
normalizeBalances(state);
snapshotDaily(state);
const after = Object.fromEntries(Object.values(state.users || {}).map(u => [u.name, u.balance]));
const changes = Object.keys(after)
  .sort((a,b) => a.localeCompare(b, "zh-CN"))
  .map(name => ({user:name, before:before[name], after:after[name], delta:after[name] - (before[name] ?? 0)}))
  .filter(r => r.delta !== 0);

console.log(JSON.stringify({
  mode:APPLY ? "apply" : "dry-run",
  backupPath,
  users:Object.keys(after).length,
  bets:(state.bets || []).length,
  changedUsers:changes
}, null, 2));

if(APPLY){
  await client.saveState(state);
  console.log("Supabase balances repaired from recorded bets.");
}else{
  console.log("Dry run only. Re-run with APPLY=1 to write Supabase.");
}
