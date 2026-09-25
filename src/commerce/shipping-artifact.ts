import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import sharp from 'sharp';
import { conflict } from './domain.js';
import { publicAddress,publicEndpoint } from './public-http.js';

const MAX_BYTES=5*1024*1024;
export type ShippingArtifact = {artifact:'pdf';mime:'application/pdf';base64:string}
  | {artifact:'label_qr';mime:'image/png';base64:string;width:number;height:number};

/** The caller must have reconciled a paid provider transaction and authorized
 * the sender before invoking this. A URL, PDF or PNG cannot prove purchase,
 * QR semantics or drop-off compatibility. Never call with model/client URLs. */
export async function downloadShippingArtifact(value:string,artifact:'pdf'|'label_qr'):Promise<ShippingArtifact> {
  try {
    if(value.length>8192 || !URL.canParse(value)) throw new Error();
    const url=new URL(value);
    if(url.username || url.password || url.hash || !publicEndpoint(`${url.origin}${url.pathname}`)) throw new Error();
    // Signed query values are permitted only for this exact private download.
    // They never enter a public URL, redirect, log or exception message.
    const signal=AbortSignal.timeout(15_000);
    const answers=await Promise.race([lookup(url.hostname,{all:true}),
      new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error()),{once:true}))]);
    if(signal.aborted || !answers.length || answers.some(answer=>!publicAddress(answer.address))) throw new Error();
    const selected=answers[0]!;
    const result=await new Promise<{bytes:Buffer;mime:string}>((resolve,reject)=>{
      const req=request(url,{method:'GET',agent:false,signal,headers:{'accept-encoding':'identity',
        accept:artifact==='pdf'?'application/pdf':'image/png','user-agent':'TBD-private-postage/1.0'},
      lookup:(_host,options,done)=>options.all?done(null,[selected]):done(null,selected.address,selected.family)},res=>{
        const mime=String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if(res.statusCode!==200 || mime!==(artifact==='pdf'?'application/pdf':'image/png')
          || !['','identity'].includes(String(res.headers['content-encoding'] ?? ''))
          || Number(res.headers['content-length'] ?? 0)>MAX_BYTES) {res.destroy();reject(new Error());return;}
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(chunk:Buffer)=>{
          size+=chunk.length;
          if(size>MAX_BYTES) {res.destroy();reject(new Error());return;}
          chunks.push(chunk);
        });
        res.on('end',()=>resolve({bytes:Buffer.concat(chunks),mime}));
        res.on('aborted',()=>reject(new Error()));res.on('error',()=>reject(new Error()));
      });
      req.on('error',()=>reject(new Error()));req.end();
    });
    return await validateShippingArtifact(result.bytes,result.mime,artifact);
  } catch {conflict('The paid postage artifact could not be retrieved. Ask your agent to reconcile the existing shipment.');}
}
export async function validateShippingArtifact(bytes:Buffer,mime:string,artifact:'pdf'|'label_qr'):Promise<ShippingArtifact> {
  if(!bytes.length || bytes.length>MAX_BYTES) conflict('Postage artifact size is not supported.');
  if(artifact==='pdf') {
    if(mime!=='application/pdf' || !/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(bytes.subarray(0,8).toString('ascii'))
      || !bytes.subarray(-1024).toString('ascii').includes('%%EOF')) conflict('Provider artifact is not a complete printable PDF.');
    return {artifact,mime,base64:bytes.toString('base64')};
  }
  if(mime!=='image/png' || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) conflict('Provider printing code is not a supported PNG.');
  try {
    const input=sharp(bytes,{limitInputPixels:4_194_304,animated:false,failOn:'warning'});
    const meta=await input.metadata();
    if(meta.format!=='png' || !meta.width || !meta.height || meta.width>2048 || meta.height>2048 || (meta.pages ?? 1)!==1) throw new Error();
    // Lossless decode/re-encode strips metadata without resizing, cropping,
    // rotating or substituting a tracking number for a provider printing code.
    const clean=await input.png().toBuffer();
    if(clean.length>MAX_BYTES) throw new Error();
    return {artifact,mime:'image/png',base64:clean.toString('base64'),width:meta.width,height:meta.height};
  } catch {conflict('Provider printing code could not be decoded.');}
}
