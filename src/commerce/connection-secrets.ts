import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/** Domain-separated key from the existing server root secret. Ciphertexts are
 * bound to connection/owner/mode/endpoint, so copied rows cannot swap accounts. */
export class ConnectionSecrets {
  private readonly key: Buffer;
  constructor(rootSecret:string) {
    if(rootSecret.length<32) throw new Error('Server root secret is required.');
    this.key=Buffer.from(hkdfSync('sha256',rootSecret,'tbd-service-connections-v1','oauth-credentials',32));
  }
  seal(binding:string,value:unknown) {
    const nonce=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',this.key,nonce);
    cipher.setAAD(Buffer.from(binding));
    const content=Buffer.from(JSON.stringify(value));
    if(content.length>65536) throw new Error('Credential limit exceeded.');
    const encrypted=Buffer.concat([cipher.update(content),cipher.final()]);
    return [nonce,cipher.getAuthTag(),encrypted].map(x=>x.toString('base64url')).join('.');
  }
  open<T>(binding:string,value:string):T {
    const parts=value.split('.');
    if(parts.length!==3) throw new Error('Invalid connection credentials.');
    const [nonce,tag,encrypted]=parts.map(x=>Buffer.from(x,'base64url'));
    const cipher=createDecipheriv('aes-256-gcm',this.key,nonce!);
    cipher.setAAD(Buffer.from(binding));cipher.setAuthTag(tag!);
    return JSON.parse(Buffer.concat([cipher.update(encrypted!),cipher.final()]).toString('utf8')) as T;
  }
}
