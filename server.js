import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import LRU from 'lru-cache';
import { JSDOM } from 'jsdom';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('.'));
app.use(express.json());

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use('/api/', limiter);
const cache = new LRU({ max: 500, ttl: 1000 * 60 * 5 });

function safeParseJSON(s){ try { return JSON.parse(s); } catch(e){ return null; } }
function dedupe(media){ const seen = new Set(); return media.filter(m => { if(seen.has(m.url)) return false; seen.add(m.url); return true; }); }
async function fetchHtml(url){ const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }); return await res.text(); }

function extractInstagramMedia(html){
  const media = [];
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // OG tags
  const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
  const ogVideo = doc.querySelector('meta[property="og:video"]')?.content;
  if(ogImage) media.push({type:'image',url:ogImage});
  if(ogVideo) media.push({type:'video',url:ogVideo});

  // JSON-LD
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s=>{
    const j = safeParseJSON(s.textContent);
    if(j?.image){ if(Array.isArray(j.image)) j.image.forEach(u=>media.push({type:'image',url:u})); else media.push({type:'image',url:j.image}); }
  });

  // window._sharedData
  const match = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});/);
  if(match){
    const j = safeParseJSON(match[1]);
    try{
      const entry = j?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
      if(entry){
        if(entry.__typename==='GraphSidecar'){
          entry.edge_sidecar_to_children.edges.forEach(e=>{
            const node = e.node;
            if(node.__typename==='GraphVideo') media.push({type:'video',url:node.video_url});
            else media.push({type:'image',url:node.display_url});
          });
        } else if(entry.__typename==='GraphVideo') media.push({type:'video',url:entry.video_url});
        else media.push({type:'image',url:entry.display_url});
      }
    }catch(e){}
  }

  return dedupe(media);
}

app.get('/api/fetch', async(req,res)=>{
  const url=req.query.url;
  if(!url) return res.status(400).json({error:'Missing url'});
  if(cache.has(url)) return res.json({media: cache.get(url),cached:true});
  try{
    const html = await fetchHtml(url);
    const media = extractInstagramMedia(html);
    cache.set(url,media);
    res.json({media});
  }catch(e){ res.status(500).json({error:'Server error'}); }
});

app.get('/api/proxy', async(req,res)=>{
  const fileUrl=req.query.url;
  if(!fileUrl) return res.status(400).send('Missing url');
  try{
    const remote = await fetch(fileUrl);
    res.setHeader('Content-Type', remote.headers.get('content-type')||'application/octet-stream');
    remote.body.pipe(res);
  }catch(e){ res.status(500).send('Proxy error'); }
});

app.listen(PORT,()=>console.log(`Server running on port ${PORT}`));
