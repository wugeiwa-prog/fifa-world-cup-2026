const TABLES={
  legacy:"wc2026_state",
  users:"wc2026_users",
  bets:"wc2026_bets",
  daily:"wc2026_daily",
  results:"wc2026_results",
  odds:"wc2026_odds",
  comments:"wc2026_comments",
  replies:"wc2026_comment_replies",
  meta:"wc2026_sync_meta"
};

function normalize(db){
  db=Object.assign({users:{},bets:[],daily:{},results:{},resultSync:{},odds:{},oddsSync:{},comments:[]},db||{});
  db.users=db.users||{};db.bets=Array.isArray(db.bets)?db.bets:[];db.daily=db.daily||{};db.results=db.results||{};db.resultSync=db.resultSync||{};db.odds=db.odds||{};db.oddsSync=db.oddsSync||{};db.comments=Array.isArray(db.comments)?db.comments:[];
  return db;
}
function makeClient({url,anonKey,legacyTable="wc2026_state",rowId="global"}){
  const base=String(url||"").replace(/\/$/,"");
  const headers=body=>({
    apikey:anonKey,
    Authorization:`Bearer ${anonKey}`,
    ...(body?{"Content-Type":"application/json","Prefer":"resolution=merge-duplicates,return=representation"}:{})
  });
  async function rest(method,path,body){
    const res=await fetch(`${base}/rest/v1/${path}`,{method,headers:headers(!!body),body:body?JSON.stringify(body):undefined});
    if(!res.ok)throw new Error(`Supabase ${method} ${res.status}: ${await res.text()}`);
    return res.status===204?null:res.json();
  }
  async function pullLegacy(){
    const rows=await rest("GET",`${legacyTable}?id=eq.${encodeURIComponent(rowId)}&select=data`);
    return Array.isArray(rows)&&rows[0]?.data?normalize(rows[0].data):normalize({});
  }
  function fromRows(rows){
    const db=normalize({});
    (rows.users||[]).forEach(r=>{db.users[r.name]={name:r.name,balance:Number(r.balance)||0,createdAt:Number(r.created_at)||0,updatedAt:Number(r.updated_at)||0};});
    db.bets=(rows.bets||[]).map(r=>({id:r.id,user:r.user_name,mid:r.mid,type:r.type,pick:r.pick,odds:Number(r.odds)||0,stake:Number(r.stake)||0,status:r.status,payout:r.payout==null?undefined:Number(r.payout),placedAt:Number(r.placed_at)||0,settledAt:r.settled_at==null?undefined:Number(r.settled_at),updatedAt:Number(r.updated_at)||0}));
    (rows.daily||[]).forEach(r=>{(db.daily[r.day] ||= []).push({user:r.user_name,balance:Number(r.balance)||0});});
    Object.keys(db.daily).forEach(k=>db.daily[k].sort((a,b)=>b.balance-a.balance));
    (rows.results||[]).forEach(r=>{db.results[r.mid]={score:r.score,status:r.status,source:r.source,sourceUrl:r.source_url,updatedAt:r.updated_at};});
    (rows.odds||[]).forEach(r=>{db.odds[r.mid]={h:Number(r.h),d:Number(r.d),a:Number(r.a),source:r.source,url:r.url,updatedAt:r.updated_at,market:r.market};});
    const repliesByComment={};
    (rows.replies||[]).forEach(r=>{(repliesByComment[r.comment_id] ||= []).push({id:r.id,user:r.user_name,text:r.text,createdAt:Number(r.created_at)||0});});
    db.comments=(rows.comments||[]).map(r=>({id:r.id,user:r.user_name,text:r.text,createdAt:Number(r.created_at)||0,updatedAt:Number(r.updated_at)||0,replies:(repliesByComment[r.id]||[]).sort((a,b)=>(a.createdAt||0)-(b.createdAt||0))})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,200);
    (rows.meta||[]).forEach(r=>{if(r.key==="resultSync")db.resultSync=r.data||{};if(r.key==="oddsSync")db.oddsSync=r.data||{};});
    return db;
  }
  async function pullTables(){
    const [users,bets,daily,results,odds,comments,replies,meta]=await Promise.all([
      rest("GET",`${TABLES.users}?select=*`),
      rest("GET",`${TABLES.bets}?select=*`),
      rest("GET",`${TABLES.daily}?select=*`),
      rest("GET",`${TABLES.results}?select=*`),
      rest("GET",`${TABLES.odds}?select=*`),
      rest("GET",`${TABLES.comments}?select=*`),
      rest("GET",`${TABLES.replies}?select=*`),
      rest("GET",`${TABLES.meta}?select=*`)
    ]);
    return fromRows({users,bets,daily,results,odds,comments,replies,meta});
  }
  function rowsFromDB(db){
    db=normalize(db);
    const nowIso=new Date().toISOString();
    return {
      users:Object.values(db.users).map(u=>({name:u.name,balance:u.balance||0,created_at:u.createdAt||Date.now(),updated_at:u.updatedAt||Date.now()})),
      bets:db.bets.map(b=>({id:b.id,user_name:b.user,mid:b.mid,type:b.type,pick:b.pick,odds:b.odds,stake:b.stake,status:b.status,payout:b.payout??null,placed_at:b.placedAt||Date.now(),settled_at:b.settledAt??null,updated_at:b.updatedAt||b.settledAt||b.placedAt||Date.now()})),
      daily:Object.entries(db.daily).flatMap(([day,rows])=>(rows||[]).map(r=>({day,user_name:r.user,balance:r.balance||0}))),
      results:Object.entries(db.results).map(([mid,r])=>({mid,score:r.score,status:r.status,source:r.source||null,source_url:r.sourceUrl||r.source_url||null,updated_at:r.updatedAt||r.sourceUpdatedAt||nowIso})),
      odds:Object.entries(db.odds).map(([mid,o])=>({mid,h:o.h,d:o.d,a:o.a,source:o.source||null,url:o.url||null,updated_at:o.updatedAt||o.updated||nowIso,market:o.market||"1X2"})),
      comments:db.comments.map(c=>({id:c.id,user_name:c.user,text:c.text,created_at:c.createdAt||Date.now(),updated_at:c.updatedAt||c.createdAt||Date.now()})),
      replies:db.comments.flatMap(c=>(c.replies||[]).map(r=>({id:r.id,comment_id:c.id,user_name:r.user,text:r.text,created_at:r.createdAt||Date.now()}))),
      meta:[
        ...(Object.keys(db.resultSync||{}).length?[{key:"resultSync",data:db.resultSync,updated_at:nowIso}]:[]),
        ...(Object.keys(db.oddsSync||{}).length?[{key:"oddsSync",data:db.oddsSync,updated_at:nowIso}]:[])
      ]
    };
  }
  async function upsert(table,rows){if(rows.length)await rest("POST",table,rows);}
  async function pushTables(db){
    const r=rowsFromDB(db);
    await upsert(TABLES.users,r.users);
    await upsert(TABLES.bets,r.bets);
    await upsert(TABLES.daily,r.daily);
    await upsert(TABLES.results,r.results);
    await upsert(TABLES.odds,r.odds);
    await upsert(TABLES.comments,r.comments);
    await upsert(TABLES.replies,r.replies);
    await upsert(TABLES.meta,r.meta);
  }
  async function pushLegacy(db){
    await rest("POST",legacyTable,{id:rowId,data:normalize(db),updated_at:new Date().toISOString()});
  }
  return {
    async loadState(){try{
      const tableDb=await pullTables();
      const hasTableData=Object.keys(tableDb.users||{}).length||tableDb.bets.length||tableDb.comments.length||Object.keys(tableDb.results||{}).length||Object.keys(tableDb.odds||{}).length;
      return hasTableData?tableDb:await pullLegacy();
    }catch(e){return await pullLegacy();}},
    async saveState(db){try{await pushTables(db);try{await pushLegacy(db);}catch(e){}}catch(e){await pushLegacy(db);}}
  };
}

export {makeClient,TABLES};
