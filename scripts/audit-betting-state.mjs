const SUPABASE_URL = process.env.SUPABASE_URL || "https://dngazmrtmtdahbrlazcj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_-bRXY4XdE8-mbyEHVnxvGw_EfCd8RuY";
const INIT_BALANCE = Number(process.env.INIT_BALANCE || 1000);

const base = SUPABASE_URL.replace(/\/$/,"");
const headers = {apikey:SUPABASE_ANON_KEY, Authorization:`Bearer ${SUPABASE_ANON_KEY}`};

async function readTable(table){
  const res = await fetch(`${base}/rest/v1/${table}?select=*`, {headers});
  if(!res.ok)throw new Error(`Read ${table} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const [users, bets, results] = await Promise.all([
  readTable("wc2026_users"),
  readTable("wc2026_bets"),
  readTable("wc2026_results")
]);

const finalResults = new Set(
  results
    .filter(r => String(r.status || "").toLowerCase() === "final" && r.score)
    .map(r => r.mid)
);

const openWithResult = bets.filter(b => b.status === "open" && finalResults.has(b.mid));
const settledMissing = bets.filter(b => ["won","lost"].includes(b.status) && (b.payout == null || !b.settled_at));
const invalidStatus = bets.filter(b => !["open","won","lost"].includes(b.status));
const lostWithPayout = bets.filter(b => b.status === "lost" && Number(b.payout || 0) > 0);
const wonMissingPayout = bets.filter(b => b.status === "won" && !(Number(b.payout) > 0));

function expectedBalance(name){
  const mine = bets.filter(b => b.user_name === name);
  const staked = mine.reduce((s,b) => s + (Number(b.stake) || 0), 0);
  const returned = mine.reduce((s,b) => s + (Number(b.payout) || 0), 0);
  return INIT_BALANCE - staked + returned;
}

const balanceMismatches = users
  .map(u => ({user:u.name, balance:Number(u.balance) || 0, expectedFromRecordedBets:expectedBalance(u.name)}))
  .map(r => ({...r, delta:r.balance - r.expectedFromRecordedBets}))
  .filter(r => r.delta !== 0);

const report = {
  users:users.length,
  bets:bets.length,
  results:results.length,
  openWithResult,
  settledMissing,
  invalidStatus,
  lostWithPayout,
  wonMissingPayout,
  balanceMismatches
};

console.log(JSON.stringify(report, null, 2));

if(openWithResult.length || settledMissing.length || invalidStatus.length || lostWithPayout.length || wonMissingPayout.length || balanceMismatches.length){
  process.exitCode = 1;
}
