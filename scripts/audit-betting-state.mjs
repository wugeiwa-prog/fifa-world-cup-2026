import {makeClient} from "./supabase-state.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const INIT_BALANCE = Number(process.env.INIT_BALANCE || 1000);

const client = makeClient({url:SUPABASE_URL, anonKey:SUPABASE_ANON_KEY});
const db = await client.loadState();

const finalResults = new Set(
  Object.entries(db.results || {})
    .filter(([,r]) => String(r.status || "").toLowerCase() === "final" && r.score)
    .map(([mid]) => mid)
);

const openWithResult = db.bets.filter(b => b.status === "open" && finalResults.has(b.mid));
const settledMissing = db.bets.filter(b => ["won","lost"].includes(b.status) && (b.payout == null || !b.settledAt));
const invalidStatus = db.bets.filter(b => !["open","won","lost"].includes(b.status));

function expectedBalance(name){
  const bets = db.bets.filter(b => b.user === name);
  const staked = bets.reduce((s,b) => s + (b.stake || 0), 0);
  const returned = bets.reduce((s,b) => s + (b.payout || 0), 0);
  return INIT_BALANCE - staked + returned;
}

const balanceMismatches = Object.values(db.users || {})
  .map(u => ({user:u.name, balance:u.balance, expectedFromRecordedBets:expectedBalance(u.name)}))
  .map(r => ({...r, delta:r.balance - r.expectedFromRecordedBets}))
  .filter(r => r.delta !== 0);

const report = {
  users:Object.keys(db.users || {}).length,
  bets:db.bets.length,
  results:Object.keys(db.results || {}).length,
  openWithResult,
  settledMissing,
  invalidStatus,
  balanceMismatches
};

console.log(JSON.stringify(report, null, 2));

if(openWithResult.length || settledMissing.length || invalidStatus.length){
  process.exitCode = 1;
}
