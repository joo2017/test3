#!/usr/bin/env node
import { DateTime } from "luxon";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import minimist from "minimist";

const INDEX_URL = "https://kpopofficial.com/kpop-comebacks/";
const CATEGORY_URL = "https://kpopofficial.com/category/kpop-comeback-schedule/";
const SITE = "https://kpopofficial.com";
const TZ = "Asia/Seoul";

function home(){ return process.env.HOME || process.env.USERPROFILE || "."; }
function outDir(){ return process.env.KPOP_SCHEDULE_DIR || path.join(home(), ".openclaw", "kpop_schedule_strict"); }
async function ensureDir(p){ await fs.mkdir(p, {recursive:true}); }
const sha1 = (s)=>crypto.createHash("sha1").update(s).digest("hex");

function randInt(min, max){ return Math.floor(min + Math.random() * (max - min + 1)); }
async function sleep(ms){ await new Promise(r=>setTimeout(r, ms)); }

function looksLikeChallenge(html){
  const t=(html||"").toLowerCase();
  return t.includes("cloudflare") || t.includes("checking your browser")
      || t.includes("attention required") || t.includes("enable javascript")
      || t.includes("ddos protection");
}

function cleanUrl(u){
  try{ const x=new URL(u); x.hash=""; x.search=""; return x.toString(); }
  catch{ return u; }
}

async function fetchHtml(url, {timeoutMs=25000, retries=2, backoffBaseMs=800} = {}){
  const headers = {
    "user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language":"en-US,en;q=0.9,ko;q=0.7,zh-CN;q=0.6,zh;q=0.5",
    "cache-control":"no-cache",
    "pragma":"no-cache",
    "referer": SITE + "/"
  };
  let last=null;
  for(let i=0;i<=retries;i++){
    try{
      const ctrl=new AbortController();
      const t=setTimeout(()=>ctrl.abort(), timeoutMs);
      const res=await fetch(url, {headers, signal: ctrl.signal, redirect:"follow"});
      clearTimeout(t);

      if(res.status === 404){
        const err = new Error("HTTP 404 Not Found");
        err.code = 404;
        throw err;
      }
      if([429,500,502,503,504].includes(res.status)) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    }catch(e){
      last=e;
      if(e && e.code === 404) throw e;
      const wait = backoffBaseMs * Math.pow(2, i) + randInt(0, 400);
      await sleep(wait);
    }
  }
  throw last;
}

// Discover monthly pages with pagination; stop on 404
function extractMonthlyLinks(html, baseUrl){
  const $=cheerio.load(html);
  const out=new Set();
  $("a[href]").each((_,a)=>{
    const href=$(a).attr("href"); if(!href) return;
    const abs=cleanUrl(new URL(href, baseUrl).toString());
    if(abs.startsWith(SITE) && /kpop-comeback-schedule/i.test(abs)) out.add(abs);
  });
  return Array.from(out);
}
function nextPageUrl(html, currentUrl){
  const $=cheerio.load(html);
  const next = $('link[rel="next"]').attr("href") || $('a[rel="next"]').attr("href");
  if(next) return cleanUrl(new URL(next, currentUrl).toString());
  if(!/\/page\/\d+\//.test(currentUrl)) return currentUrl.replace(/\/$/, "") + "/page/2/";
  const m=currentUrl.match(/\/page\/(\d+)\//);
  if(m) return currentUrl.replace(/\/page\/\d+\//, `/page/${Number(m[1])+1}/`);
  return null;
}
async function discoverMonthlyPages(maxPages, out, warnings){
  await ensureDir(path.join(out,"raw","monthly_index"));
  const pages=[]; const monthPages=new Set();
  let url=CATEGORY_URL;

  for(let i=0;i<maxPages;i++){
    try{
      const html=await fetchHtml(url);
      pages.push(url);
      await fs.writeFile(path.join(out,"raw","monthly_index",`cat-${i+1}.html`), html, "utf8");
      if(looksLikeChallenge(html)) warnings.push(`challenge-like category page: ${url}`);
      extractMonthlyLinks(html, url).forEach(u=>monthPages.add(u));

      const nxt=nextPageUrl(html, url);
      if(!nxt || nxt===url) break;
      url=nxt;
      await sleep(250);
    }catch(e){
      if(e && e.code === 404){
        warnings.push(`category pagination ended (404): ${url}`);
        break;
      }
      warnings.push(`category page fetch failed: ${url} :: ${String(e)}`);
      break;
    }
  }

  // Fallback: index discovery always attempted
  try{
    const idxHtml=await fetchHtml(INDEX_URL, {retries:3, backoffBaseMs:1000});
    await fs.writeFile(path.join(out,"raw","monthly_index","index.html"), idxHtml, "utf8");
    extractMonthlyLinks(idxHtml, INDEX_URL).forEach(u=>monthPages.add(u));
  }catch(e){
    warnings.push(`index discovery failed: ${String(e)}`);
  }

  const month_pages=Array.from(monthPages);
  month_pages.sort();
  await fs.writeFile(path.join(out,"month_pages.json"), JSON.stringify({discovered_at: DateTime.now().setZone(TZ).toISO(), pages_scanned: pages, month_pages}, null, 2), "utf8");
  return month_pages;
}

// Year inference
const MONTH_NAMES = /(January|February|March|April|May|June|July|August|September|October|November|December)/i;
function inferYear(html){
  const $=cheerio.load(html);
  const title=(($("h1").first().text()||$("title").text()||"").replace(/\s+/g," ").trim());
  const m=title.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{4})/i);
  if(m) return {year:Number(m[2]), title};
  const y=title.match(/\b(20\d{2})\b/);
  return {year:y?Number(y[1]):null, title};
}

function parseDateDisplay(dateText, yearHint){
  const m=(dateText||"").match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,?\s*(\d{4}))?/i);
  if(!m) return {display:"待定（未公布具体日期）", iso_day:null, raw: dateText||""};
  const monthMap={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
  const month=monthMap[m[1].toLowerCase()];
  const day=Number(m[2]);
  const year=m[3]?Number(m[3]):(yearHint || DateTime.now().setZone(TZ).year);
  const dt=DateTime.fromObject({year,month,day},{zone:TZ});
  return {display: dt.toISODate(), iso_day: dt.toISODate(), raw: dateText||""};
}

function classifyMeta(meta){
  const dateText = meta.find(t=>MONTH_NAMES.test(t) || /Coming Soon/i.test(t)) || "";
  const title = meta.find(t=>/(EP|Album|Single|OST|Repackage)/i.test(t)) || meta.find(t=>/ – /i.test(t) && !/Coming Soon/i.test(t)) || "";
  const monthAbbrev=/^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/i;
  const artist = meta.find(t=>t && t!==dateText && t!==title && !MONTH_NAMES.test(t) && !/Coming Soon/i.test(t)
                    && !monthAbbrev.test(t) && !/(EP|Album|Single|OST|Repackage)/i.test(t)) || "";
  return {dateText, artist, title};
}

function extractCardsFromDoc($){
  const cards=[];
  $("li.gspbgrid_item").each((_,li)=>{
    const card=$(li);
    const link = card.find("a.gspbgrid_item_link[href]").attr("href")
      || card.find("a.gspb-containerlink[href]").attr("href")
      || card.find("a[href*='/album/']").first().attr("href");
    if(!link) return;
    const detail=cleanUrl(link);
    const meta=[];
    card.find(".gspb_meta_value").each((_,el)=>meta.push($(el).text().replace(/\s+/g," ").trim()));
    const uniq=[]; for(const m of meta){ if(m && !uniq.includes(m)) uniq.push(m); }
    cards.push({detail_url: detail, meta: uniq});
  });
  return cards;
}

async function run(){
  const argv=minimist(process.argv.slice(2), {default:{source:"monthly","max-pages":12,months:12}});
  const source=(argv.source||"monthly").toLowerCase();
  const maxPages=Math.max(1, Number(argv["max-pages"]||12));
  const monthsLimit=Math.max(1, Number(argv.months||12));

  const out=outDir();
  await ensureDir(out);
  await ensureDir(path.join(out,"raw","monthly"));
  const warnings=[];
  const today=DateTime.now().setZone(TZ).toISODate();
  const nowY=DateTime.now().setZone(TZ).year;

  let monthPages=[];
  if(source==="monthly") monthPages = await discoverMonthlyPages(maxPages, out, warnings);
  else monthPages = [INDEX_URL];

  const pageInfos=[];
  for(const p of monthPages){
    try{
      const html=await fetchHtml(p, {retries:2, backoffBaseMs:1000});
      await fs.writeFile(path.join(out,"raw","monthly",`${sha1(p).slice(0,10)}.html`), html, "utf8");
      if(looksLikeChallenge(html)){ warnings.push(`challenge-like monthly HTML: ${p}`); continue; }
      const info=inferYear(html);
      if(info.year && info.year < nowY) continue;
      pageInfos.push({url:p, html, year: info.year});
    }catch(e){
      if(e && e.code===404){ warnings.push(`skip monthly 404: ${p}`); continue; }
      warnings.push(`fetch monthly failed: ${p} :: ${String(e)}`);
      continue;
    }
    await sleep(120);
  }
  pageInfos.sort((a,b)=>(a.year||9999)-(b.year||9999));
  const used=pageInfos.slice(0, monthsLimit);

  const items=[];
  for(const pi of used){
    const $=cheerio.load(pi.html);
    for(const c of extractCardsFromDoc($)){
      const {dateText, artist, title} = classifyMeta(c.meta);
      const parsed = parseDateDisplay(dateText, pi.year);
      if(parsed.iso_day && parsed.iso_day < today) continue;
      items.push({
        sort_key: parsed.iso_day ? parsed.iso_day : "9999-12-31",
        回归日期: parsed.iso_day ? parsed.display : "待定（未公布具体日期）",
        艺人: artist || "待定（未公布具体信息）",
        专辑名: title || "待定（未公布具体信息）",
        详情链接: c.detail_url,
        date_text_raw: dateText || "",
        source_page: pi.url
      });
    }
  }
  // dedup+sort
  const seen=new Set(); const dedup=[];
  for(const it of items){
    const key=`${it.详情链接}|${it.date_text_raw}|${it.专辑名}|${it.艺人}`;
    if(seen.has(key)) continue;
    seen.add(key); dedup.push(it);
  }
  dedup.sort((a,b)=>a.sort_key.localeCompare(b.sort_key) || (a.艺人||"").localeCompare(b.艺人||"") || (a.专辑名||"").localeCompare(b.专辑名||""));
  const schedule=dedup.map(({sort_key, ...rest})=>rest);

  await fs.writeFile(path.join(out,"schedule.json"), JSON.stringify(schedule,null,2), "utf8");
  const summary={ok:true, source, today, month_pages_discovered: monthPages.length, month_pages_used: used.length, schedule_count: schedule.length, output_dir: out, warnings};
  await fs.writeFile(path.join(out,"summary.json"), JSON.stringify(summary,null,2), "utf8");
  console.log(JSON.stringify(summary,null,2));
}

run().catch(e=>{ console.error(e); process.exit(1); });
