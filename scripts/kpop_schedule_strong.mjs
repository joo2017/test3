\
#!/usr/bin/env node
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import minimist from "minimist";
import * as cheerio from "cheerio";
import { DateTime } from "luxon";

const SITE = "https://kpopofficial.com";
const CATEGORY_URL = "https://kpopofficial.com/category/kpop-comeback-schedule/";
const TZ_DEFAULT = "Asia/Seoul";

function sha256(s){ return crypto.createHash("sha256").update(s).digest("hex"); }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function cleanUrl(u){
  try { const x = new URL(u); x.hash=""; return x.toString(); } catch { return u; }
}
function home(){ return process.env.HOME || process.env.USERPROFILE || "."; }
function outDir(){ return process.env.KPOP_SCHEDULE_DIR || path.join(home(), ".openclaw", "kpop_schedule_strong"); }
async function ensureDir(p){ await fsp.mkdir(p, {recursive:true}); }
async function writeText(p, s){ await ensureDir(path.dirname(p)); await fsp.writeFile(p, s, "utf8"); }
async function writeJson(p, obj){ await ensureDir(path.dirname(p)); await fsp.writeFile(p, JSON.stringify(obj, null, 2), "utf8"); }
async function readJson(p, fb){ try { return JSON.parse(await fsp.readFile(p, "utf8")); } catch { return fb; } }
async function listFiles(dir, ext){ try{ return (await fsp.readdir(dir)).filter(x=>x.endsWith(ext)).map(x=>path.join(dir,x)); }catch{ return []; } }

async function fetchHtml(url, {timeoutMs=25000, retries=2}={}){
  const headers={ "user-agent":"Mozilla/5.0 (compatible; OpenClaw-KpopScheduleStrong/1.0)", "accept":"text/html,application/xhtml+xml" };
  let last=null;
  for(let i=0;i<=retries;i++){
    try{
      const ctrl=new AbortController();
      const t=setTimeout(()=>ctrl.abort(), timeoutMs);
      const res=await fetch(url, {headers, signal: ctrl.signal});
      clearTimeout(t);
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    }catch(e){
      last=e;
      await sleep(500*(i+1));
    }
  }
  throw last;
}

// ---------- DISCOVER month pages ----------
function extractMonthPageLinks(html, baseUrl){
  const $=cheerio.load(html);
  const links=new Set();
  $("a[href]").each((_,a)=>{
    const href=$(a).attr("href"); if(!href) return;
    const abs=cleanUrl(new URL(href, baseUrl).toString());
    if(abs.startsWith(SITE) && /kpop-comeback-schedule/i.test(abs)) links.add(abs);
  });
  return Array.from(links);
}
function findNextPageUrl(html, currentUrl){
  const $=cheerio.load(html);
  const next = $('link[rel="next"]').attr("href") || $('a[rel="next"]').attr("href");
  if(next) return cleanUrl(new URL(next, currentUrl).toString());
  if(!/\/page\/\d+\//.test(currentUrl)) return currentUrl.replace(/\/$/, "") + "/page/2/";
  const m=currentUrl.match(/\/page\/(\d+)\//);
  if(m){ return currentUrl.replace(/\/page\/\d+\//, `/page/${Number(m[1])+1}/`); }
  return null;
}
async function cmdDiscover({maxPages=6}){
  const out=outDir();
  await ensureDir(path.join(out, "raw", "monthly_index"));
  const pages=[]; const monthPages=new Set();
  let url=CATEGORY_URL;
  for(let i=0;i<maxPages;i++){
    const html=await fetchHtml(url);
    pages.push(url);
    await writeText(path.join(out, "raw", "monthly_index", `index-${i+1}.html`), html);
    for(const l of extractMonthPageLinks(html, url)) monthPages.add(l);
    const next=findNextPageUrl(html, url);
    if(!next || next===url) break;
    url=next;
    await sleep(250);
  }
  const month_pages=[...monthPages];
  month_pages.sort();
  const obj={discovered_at: DateTime.now().toISO(), source: CATEGORY_URL, pages_scanned: pages, month_pages};
  await writeJson(path.join(out, "month_pages.json"), obj);
  return obj;
}

// ---------- YEAR/MONTH inference ----------
const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
function inferYearFromMonthlyTitle(html){
  const $=cheerio.load(html);
  const title=(($("h1").first().text()||$("title").text()||"").replace(/\s+/g," ").trim());
  const m=title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{4})/i);
  if(m) return {year:Number(m[2]), title};
  return {year:null, title};
}

// ---------- Date parsing ----------
function parseMainDateText(dateText, yearHint){
  const t=(dateText||"").replace(/\s+/g," ").trim();
  const m=t.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{1,2})/i);
  if(!m) return null;
  const month=MONTHS[m[1].toLowerCase()];
  const day=Number(m[2]);
  const year=yearHint || DateTime.now().year;

  let zone=TZ_DEFAULT;
  const tzHint=t.match(/\b(KST|JST|UTC|GMT)\b/i)?.[1]?.toUpperCase();
  if(tzHint==="JST") zone="Asia/Tokyo";
  if(tzHint==="UTC"||tzHint==="GMT") zone="UTC";

  let dt=DateTime.fromObject({year,month,day,hour:0,minute:0},{zone});
  const tm=t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if(tm){
    let hh=Number(tm[1]); const mm=tm[2]?Number(tm[2]):0; const ap=tm[3].toUpperCase();
    if(ap==="PM"&&hh<12) hh+=12;
    if(ap==="AM"&&hh===12) hh=0;
    dt=dt.set({hour:hh,minute:mm});
    return {raw:t,precision:"datetime",tz:zone,iso:dt.toISO(),date:dt.toISODate(),time:dt.toFormat("HH:mm")};
  }
  return {raw:t,precision:"date",tz:zone,iso:dt.toISODate(),date:dt.toISODate(),time:null};
}
function parseMonthDayShort(text, yearHint){
  const t=(text||"").replace(/\s+/g," ").trim();
  const m=t.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)\b\.?\s+(\d{1,2})/i);
  if(!m) return null;
  let key=m[1].toLowerCase();
  const map3={jan:"january",feb:"february",mar:"march",apr:"april",jun:"june",jul:"july",aug:"august",sep:"september",sept:"september",oct:"october",nov:"november",dec:"december"};
  if(map3[key]) key=map3[key];
  const month=MONTHS[key];
  const day=Number(m[2]);
  const year=yearHint || DateTime.now().year;
  const dt=DateTime.fromObject({year,month,day},{zone:TZ_DEFAULT});
  return {date:dt.toISODate(), raw:t};
}
function extractEventsFromDateRaw(dateRaw, yearHint, mainDetail){
  const events=[];
  if(mainDetail?.date){
    events.push({event_kind:"release",event_date_iso:mainDetail.date,event_time:mainDetail.time,event_tz:mainDetail.tz||TZ_DEFAULT,event_raw_text:dateRaw});
  }
  const t=(dateRaw||"").replace(/\s+/g," ").trim();
  const pre=t.match(/Pre-?release\s*[:·-]\s*([A-Za-z]{3,9}\.?\s+\d{1,2})/i);
  if(pre){
    const d=parseMonthDayShort(pre[1],yearHint);
    if(d) events.push({event_kind:"pre_release",event_date_iso:d.date,event_time:null,event_tz:TZ_DEFAULT,event_raw_text:`Pre-release: ${d.raw}`});
  }
  const ar=t.match(/Album Release\s*[:·-]\s*([A-Za-z]{3,9}\.?\s+\d{1,2})/i);
  if(ar){
    const d=parseMonthDayShort(ar[1],yearHint);
    if(d) events.push({event_kind:"album_release",event_date_iso:d.date,event_time:null,event_tz:TZ_DEFAULT,event_raw_text:`Album Release: ${d.raw}`});
  }
  return events;
}

// ---------- Card extraction ----------
function normalizeLinesFromElement($el){
  const text=$el.text().replace(/\r/g,"").split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
  const out=[];
  for(const line of text){ if(!out.length || out[out.length-1]!==line) out.push(line); }
  return out;
}
function findCardContainer($, $a){
  let cur=$a;
  for(let i=0;i<8;i++){
    const parent=cur.parent();
    if(!parent || !parent.length) break;
    const lines=normalizeLinesFromElement(parent);
    const hasMonth=lines.some(l=>/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l));
    if(hasMonth && lines.length>=3) return parent;
    cur=parent;
  }
  const article=$a.closest("article, li, div");
  return article && article.length ? article : $a.parent();
}
function parseCardLinesToFields(lines){
  let dateIdx=lines.findIndex(l=>/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(l));
  if(dateIdx<0) dateIdx=0;
  const date_raw=lines[dateIdx]||"";
  let artist_raw="";
  const info_lines=[];
  for(let i=dateIdx+1;i<lines.length;i++){
    const l=lines[i];
    if(!artist_raw && l && !/views?/i.test(l) && !/^https?:\/\//i.test(l)){
      artist_raw=l;
      continue;
    }
    if(l && !/views?/i.test(l) && !/^https?:\/\//i.test(l)) info_lines.push(l);
  }
  return {date_raw, artist_raw, info_lines: info_lines.slice(0,4)};
}

// ---------- EVENTS from monthly pages ----------
async function cmdEvents({months=6}){
  const out=outDir();
  await ensureDir(path.join(out, "raw", "monthly"));
  const mp=await readJson(path.join(out, "month_pages.json"), null);
  if(!mp?.month_pages?.length) throw new Error("month_pages.json not found. Run discover first.");
  const pages=mp.month_pages.slice(0, Math.max(1, Number(months)||6));
  const now=DateTime.now().setZone(TZ_DEFAULT);

  const eventsByKey=new Map();
  const entitiesSeed=new Map();

  for(let i=0;i<pages.length;i++){
    const pageUrl=pages[i];
    const html=await fetchHtml(pageUrl);
    await writeText(path.join(out, "raw", "monthly", `month-${i+1}.html`), html);
    const {year} = inferYearFromMonthlyTitle(html);
    const yearHint = year || now.year;
    const $=cheerio.load(html);

    const albumLinks=[];
    $("a[href]").each((_,a)=>{
      const href=$(a).attr("href"); if(!href) return;
      const abs=cleanUrl(new URL(href, pageUrl).toString());
      if(/^https?:\/\/kpopofficial\.com\/album\/.+/i.test(abs)) albumLinks.push({abs, el:a});
    });

    const seen=new Set();
    for(const {abs, el} of albumLinks){
      if(seen.has(abs)) continue;
      seen.add(abs);
      const $a=$(el);
      const $card=findCardContainer($, $a);
      const lines=normalizeLinesFromElement($card);
      const {date_raw, artist_raw, info_lines}=parseCardLinesToFields(lines);
      const main=parseMainDateText(date_raw, yearHint);
      const expanded=extractEventsFromDateRaw(date_raw, yearHint, main);

      const entity_key=abs;
      if(!entitiesSeed.has(entity_key)){
        entitiesSeed.set(entity_key, {entity_key, detail_url:abs, artist_raw:artist_raw||null, info_raw: info_lines.join(" | ")||null, first_seen_page:pageUrl, raw_lines: lines.slice(0,10)});
      }

      const evList = expanded.length ? expanded : [{event_kind:"unknown",event_date_iso:main?.date||null,event_time:main?.time||null,event_tz:main?.tz||TZ_DEFAULT,event_raw_text:date_raw}];
      for(const ev of evList){
        const key = ev.event_date_iso
          ? sha256(`${entity_key}|${ev.event_kind}|${ev.event_date_iso}|${ev.event_time||""}|${ev.event_tz||""}`)
          : sha256(`${entity_key}|${ev.event_kind}|TBD|${ev.event_raw_text||""}`);
        const obj = eventsByKey.get(key) || {event_key:key, entity_key, detail_url:abs, event_kind:ev.event_kind, event_date_iso:ev.event_date_iso||null, event_time:ev.event_time||null, event_tz:ev.event_tz||TZ_DEFAULT, event_raw_text:ev.event_raw_text||"", sources:[]};
        obj.sources.push({page:pageUrl});
        eventsByKey.set(key,obj);
      }
    }

    await sleep(300);
  }

  const events=[...eventsByKey.values()].sort((a,b)=>String(a.event_date_iso||"9999-99-99").localeCompare(String(b.event_date_iso||"9999-99-99")));
  const entities_seed=[...entitiesSeed.values()];
  await writeJson(path.join(out, "events.json"), {generated_at: now.toISO(), months_used: pages.length, events});
  await writeJson(path.join(out, "entities_seed.json"), {generated_at: now.toISO(), months_used: pages.length, entities_seed});
  return {events_count: events.length, entities_seed_count: entities_seed.length};
}

// ---------- ENRICH entities ----------
function pickSection($, headingText){
  const header=$("h2, h3").filter((_,el)=>$(el).text().trim().toLowerCase()===headingText.toLowerCase()).first();
  if(!header||!header.length) return {text:"", links:[], images:[]};
  const section=header.nextUntil("h2, h3");
  const text=section.text().replace(/\s+/g," ").trim();
  const links=[]; section.find("a[href]").each((_,a)=>{const href=$(a).attr("href"); if(!href) return; links.push({text:$(a).text().replace(/\s+/g," ").trim(), href:cleanUrl(href)});});
  const images=[]; section.find("img").each((_,img)=>{const src=$(img).attr("src")||$(img).attr("data-src")||$(img).attr("data-lazy-src")||""; if(src) images.push(cleanUrl(src));});
  return {text, links, images};
}
function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"); }
function extractField(sectionText,label,next){
  if(!sectionText) return null;
  const t=sectionText.replace(/\s+/g," ").trim();
  const re=new RegExp(`${escapeRe(label)}\\s*(.*?)\\s*(?=\\b(${next.map(escapeRe).join("|")})\\b)`, "i");
  const m=t.match(re); return m?m[1].trim():null;
}
function parseReleaseDateFromAlbumDetails(raw){
  if(!raw) return null;
  const s=raw.replace(/\s+/g," ").trim();
  const dm=s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  if(!dm) return {raw:s, precision:"unknown", tz:TZ_DEFAULT, iso:null, date:null, time:null};
  let zone=TZ_DEFAULT;
  const hint=s.match(/\b(KST|JST|UTC|GMT)\b/i)?.[1]?.toUpperCase();
  if(hint==="JST") zone="Asia/Tokyo";
  if(hint==="UTC"||hint==="GMT") zone="UTC";
  let dt=DateTime.fromFormat(`${dm[1]} ${dm[2]} ${dm[3]}`, "LLLL d yyyy", {zone, locale:"en"});
  const tm=s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/i);
  if(tm && dt.isValid){
    let hh=Number(tm[1]); const mm=tm[2]?Number(tm[2]):0; const ap=tm[3].toUpperCase();
    if(ap==="PM"&&hh<12) hh+=12; if(ap==="AM"&&hh===12) hh=0;
    dt=dt.set({hour:hh,minute:mm,second:0,millisecond:0});
    return {raw:s,precision:"datetime",tz:zone,iso:dt.toISO(),date:dt.toISODate(),time:dt.toFormat("HH:mm")};
  }
  return {raw:s,precision:"date",tz:zone,iso:dt.toISODate(),date:dt.toISODate(),time:null};
}
function normalizeLinks(links){
  const cleaned=(links||[]).map(x=>({text:(x.text||"").trim(), href:cleanUrl(x.href||"")})).filter(x=>x.href);
  cleaned.sort((a,b)=>(a.href+a.text).localeCompare(b.href+b.text));
  return cleaned;
}
function computeEntityHash(e){
  const stable={entity_key:e.entity_key,detail_url:e.detail_url,title:e.title,artist:e.artist,album:e.album,title_track:e.title_track,release:e.release,tracklist:e.tracklist||[],links_album_details:normalizeLinks(e.links_album_details||[]),teaser_poster_images:(e.teaser_poster_images||[]).slice(0,5),comeback_teaser_images:(e.comeback_teaser_images||[]).slice(0,5),album_version_images:(e.album_version_images||[]).slice(0,5)};
  return sha256(JSON.stringify(stable));
}
async function enrichOne(detailUrl, rawDir){
  const html=await fetchHtml(detailUrl);
  await writeText(path.join(rawDir, `album-${sha256(detailUrl).slice(0,10)}.html`), html);
  const $=cheerio.load(html);
  const title=$("h1").first().text().replace(/\s+/g," ").trim()||null;
  const details=pickSection($,"Album Details");
  const artist=extractField(details.text,"Artist",["Release Date","Album","Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"]);
  const releaseRaw=extractField(details.text,"Release Date",["Album","Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"]);
  const album=extractField(details.text,"Album",["Title Track","Tracklist","Pre-save","Buy Album","Official Source","Total Views"]);
  const titleTrack=extractField(details.text,"Title Track",["Tracklist","Pre-save","Buy Album","Official Source","Total Views"]);
  const tracklistRaw=extractField(details.text,"Tracklist",["Pre-save","Buy Album","Official Source","Total Views"]);
  let tracklist=[];
  if(tracklistRaw){
    const parts=tracklistRaw.split(/\s*\d+\.\s*/).map(x=>x.trim()).filter(Boolean);
    tracklist = parts.length ? parts : tracklistRaw.split(/\s*[|/]\s*|,\s*/).map(x=>x.trim()).filter(Boolean);
    tracklist = Array.from(new Set(tracklist)).slice(0,40);
  }
  const teaser=pickSection($,"Teaser Poster");
  const comeback=pickSection($,"Comeback Teaser");
  const version=pickSection($,"Album Version");
  const entity={entity_key:detailUrl,detail_url:detailUrl,fetched_at:DateTime.now().toISO(),title,artist:artist||null,album:album||null,title_track:titleTrack||null,release:parseReleaseDateFromAlbumDetails(releaseRaw),tracklist,links_album_details:details.links||[],teaser_poster_images:teaser.images||[],comeback_teaser_images:comeback.images||[],album_version_images:version.images||[]};
  entity.hash_entity=computeEntityHash(entity);
  return entity;
}
async function cmdEnrich({concurrency=4}){
  const out=outDir();
  await ensureDir(path.join(out, "raw", "album"));
  const seed=await readJson(path.join(out, "entities_seed.json"), null);
  if(!seed?.entities_seed?.length) throw new Error("entities_seed.json not found. Run events first.");
  const urls=[...new Set(seed.entities_seed.map(x=>x.detail_url).filter(Boolean))];
  const res=new Array(urls.length);
  let idx=0;
  const workers=Array.from({length: Math.max(1, Math.min(8, Number(concurrency)||4))}, async ()=>{
    while(idx<urls.length){
      const i=idx++;
      const u=urls[i];
      try{ res[i]=await enrichOne(u, path.join(out,"raw","album")); }
      catch(e){ res[i]={error:String(e), detail_url:u}; }
      await sleep(200);
    }
  });
  await Promise.all(workers);
  const ok=res.filter(x=>x && !x.error);
  const errors=res.filter(x=>x && x.error);
  await writeJson(path.join(out,"entities.json"), {generated_at:DateTime.now().toISO(), entities_count: ok.length, errors_count: errors.length, entities: ok, errors});
  return {entities: ok.length, errors: errors.length};
}

// ---------- VIEWS ----------
function buildViews(events, nowKst, days, recentDays){
  const upcoming=[], recent=[], tbd=[];
  for(const e of events){
    if(!e.event_date_iso){ tbd.push(e); continue; }
    const dt=DateTime.fromISO(e.event_date_iso,{zone:TZ_DEFAULT});
    const diff=dt.diff(nowKst,"days").days;
    if(diff>=0 && diff<=days) upcoming.push(e);
    else if(diff<0 && diff>=-recentDays) recent.push(e);
  }
  const sort=(a,b)=>String(a.event_date_iso||"9999-99-99").localeCompare(String(b.event_date_iso||"9999-99-99"));
  upcoming.sort(sort); recent.sort(sort); tbd.sort((a,b)=>String(a.event_raw_text||"").localeCompare(String(b.event_raw_text||"")));
  return {upcoming,recent,tbd};
}
async function cmdViews({days=90, recent=7}){
  const out=outDir();
  const ev=await readJson(path.join(out,"events.json"), null);
  if(!ev?.events?.length) throw new Error("events.json not found. Run events first.");
  const now=DateTime.now().setZone(TZ_DEFAULT);
  const views=buildViews(ev.events, now, Number(days)||90, Number(recent)||7);
  await writeJson(path.join(out,"views.json"), {generated_at:now.toISO(), days:Number(days)||90, recent_days:Number(recent)||7, views});
  return {upcoming:views.upcoming.length, recent:views.recent.length, tbd:views.tbd.length};
}

// ---------- DELTA ----------
function indexByKey(arr, key){
  const m=new Map();
  for(const x of (arr||[])){ if(x && x[key]) m.set(x[key], x); }
  return m;
}
function diffKeys(prev, now){
  const added=[], removed=[], common=[];
  for(const k of now.keys()){ if(!prev.has(k)) added.push(k); else common.push(k); }
  for(const k of prev.keys()){ if(!now.has(k)) removed.push(k); }
  return {added, removed, common};
}
async function cmdDelta(){
  const out=outDir();
  await ensureDir(path.join(out,"state"));
  const now=DateTime.now().toISO();
  const ev=await readJson(path.join(out,"events.json"), null);
  const ent=await readJson(path.join(out,"entities.json"), null);
  if(!ev?.events) throw new Error("events.json missing");
  if(!ent?.entities) throw new Error("entities.json missing");

  const prevEv=await readJson(path.join(out,"state","events_snapshot.json"), {events:[]});
  const prevEnt=await readJson(path.join(out,"state","entities_snapshot.json"), {entities:[]});

  const prevE=indexByKey(prevEv.events,"event_key");
  const nowE=indexByKey(ev.events,"event_key");
  const prevEn=indexByKey(prevEnt.entities,"entity_key");
  const nowEn=indexByKey(ent.entities,"entity_key");

  const dEv=diffKeys(prevE, nowE);
  const dEn=diffKeys(prevEn, nowEn);

  const updated_events=[];
  for(const k of dEv.common){
    if(sha256(JSON.stringify(prevE.get(k))) !== sha256(JSON.stringify(nowE.get(k)))) updated_events.push(k);
  }
  const updated_entities=[];
  for(const k of dEn.common){
    const a=prevEn.get(k); const b=nowEn.get(k);
    const ha=a?.hash_entity || sha256(JSON.stringify(a));
    const hb=b?.hash_entity || sha256(JSON.stringify(b));
    if(ha!==hb) updated_entities.push(k);
  }

  const delta={generated_at:now, events:{added:dEv.added, removed:dEv.removed, updated:updated_events}, entities:{added:dEn.added, removed:dEn.removed, updated:updated_entities}};
  await writeJson(path.join(out,"delta.json"), delta);
  await writeJson(path.join(out,"state","events_snapshot.json"), {saved_at:now, events: ev.events});
  await writeJson(path.join(out,"state","entities_snapshot.json"), {saved_at:now, entities: ent.entities});
  return delta;
}

// ---------- RUN ----------
async function cmdRun({months=6, days=90, recent=7, maxPages=6, concurrency=4}){
  await cmdDiscover({maxPages});
  await cmdEvents({months});
  await cmdEnrich({concurrency});
  await cmdViews({days, recent});
  const delta=await cmdDelta();
  return {ok:true, delta};
}

async function main(){
  const argv=minimist(process.argv.slice(2), {default:{months:6, days:90, recent:7, "max-pages":6, concurrency:4}});
  const cmd=(argv._[0]||"run").toLowerCase();
  const out=outDir();
  await ensureDir(out);

  if(cmd==="discover"){ const r=await cmdDiscover({maxPages:Number(argv["max-pages"]||6)}); console.log(JSON.stringify({cmd,out,month_pages:r.month_pages.length},null,2)); return; }
  if(cmd==="events"){ const r=await cmdEvents({months:Number(argv.months||6)}); console.log(JSON.stringify({cmd,out,...r},null,2)); return; }
  if(cmd==="enrich"){ const r=await cmdEnrich({concurrency:Number(argv.concurrency||4)}); console.log(JSON.stringify({cmd,out,...r},null,2)); return; }
  if(cmd==="views"){ const r=await cmdViews({days:Number(argv.days||90), recent:Number(argv.recent||7)}); console.log(JSON.stringify({cmd,out,...r},null,2)); return; }
  if(cmd==="delta"){ const r=await cmdDelta(); console.log(JSON.stringify({cmd,out,...r},null,2)); return; }
  if(cmd==="run"){ const r=await cmdRun({months:Number(argv.months||6), days:Number(argv.days||90), recent:Number(argv.recent||7), maxPages:Number(argv["max-pages"]||6), concurrency:Number(argv.concurrency||4)}); console.log(JSON.stringify({cmd,out,...r},null,2)); return; }

  console.error("Unknown command. Use: discover|events|enrich|views|delta|run");
  process.exit(2);
}
main().catch(e=>{ console.error(`[kpop_schedule_strong] ERROR: ${e?.stack||e}`); process.exit(1); });
