import { describe,it,expect } from 'vitest';
import sharp from 'sharp';
import { validateShippingArtifact } from '../src/commerce/shipping-artifact.js';

describe('paid artifact byte validation',()=>{
  it('requires a complete PDF signature and keeps it distinct from a printing code',async()=>{
    const pdf=Buffer.from('%PDF-1.7\nfixture\n%%EOF\n');
    expect(await validateShippingArtifact(pdf,'application/pdf','pdf')).toMatchObject({artifact:'pdf',mime:'application/pdf'});
    for(const bytes of [Buffer.from('<html>paid</html>'),Buffer.from('%PDF-1.7\ntruncated'),Buffer.alloc(5*1024*1024+1)]) {
      await expect(validateShippingArtifact(bytes,'application/pdf','pdf')).rejects.toThrow();
    }
    await expect(validateShippingArtifact(pdf,'application/pdf','label_qr')).rejects.toThrow();
  });
  it('strips PNG metadata while preserving exact pixel geometry and data',async()=>{
    const source=await sharp({create:{width:80,height:96,channels:3,background:'#010203'}}).withMetadata({orientation:6}).png().toBuffer();
    const result=await validateShippingArtifact(source,'image/png','label_qr');
    expect(result).toMatchObject({artifact:'label_qr',mime:'image/png',width:80,height:96});
    const decoded=Buffer.from(result.base64,'base64'),meta=await sharp(decoded).metadata();
    expect(meta.exif).toBeUndefined();expect(meta.orientation).toBeUndefined();
    expect(await sharp(decoded).raw().toBuffer()).toEqual(await sharp(source).raw().toBuffer());
  });
  it('rejects oversized dimensions, corrupt pixels, HTML/SVG and unsupported image encodings',async()=>{
    const oversized=await sharp({create:{width:2049,height:1,channels:3,background:'white'}}).png().toBuffer();
    const jpeg=await sharp({create:{width:20,height:20,channels:3,background:'white'}}).jpeg().toBuffer();
    for(const bytes of [oversized,jpeg,Buffer.from('<svg/>'),Buffer.from([137,80,78,71,13,10,26,10])]) {
      await expect(validateShippingArtifact(bytes,'image/png','label_qr')).rejects.toThrow();
    }
  });
});
