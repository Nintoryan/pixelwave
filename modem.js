'use strict';
// Packetized 4-FSK acoustic modem, version 5. Symbols 16 ms, 2 bits/symbol.
// Packet: 24-symbol alternating sync, 4-byte magic/version/seq header, Hamming-coded bytes.
// Full packet data: [0xA7, 0x4C, 4, type, sessionLo,sessionHi, seqLo,seqHi, totalLo,totalHi,lenLo,lenHi, ...payload, crc32 LE].
// All bytes Hamming(12,8); CRC32 covers header and payload. Max 48 payload bytes.
const Modem=(()=>{
const SR=12000, DUR=.016, SPS=Math.round(SR*DUR), F=[850,1250,1650,2050], SYNC=[3,0,3,0,3,0,3,0,3,0,3,0,1,2,1,2,1,2,1,2,3,3,0,0], POS=[3,5,6,7,9,10,11,12], MAX=64, HEADER=12;
function crc32(a){let c=0xffffffff;for(const b of a){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function ham(b){let w=0;for(let i=0;i<8;i++)if(b>>i&1)w|=1<<(POS[i]-1);for(const p of [1,2,4,8]){let parity=0;for(let j=1;j<=12;j++)if(j&p)parity^=w>>(j-1)&1;if(parity)w|=1<<(p-1)}return w}
function unham(w){let s=0;for(const p of [1,2,4,8]){let v=0;for(let j=1;j<=12;j++)if(j&p)v^=w>>(j-1)&1;if(v)s|=p}if(s>12)return null;if(s)w^=1<<(s-1);let b=0;for(let i=0;i<8;i++)b|=((w>>(POS[i]-1))&1)<<i;return b}
function symbols(bytes){const out=[...SYNC];for(const b of bytes){const w=ham(b);for(let j=10;j>=0;j-=2)out.push(w>>j&3)}return out}
function packet(type,session,seq,total,payload){const a=new Uint8Array(HEADER+payload.length+4);a.set([0xa7,0x4c,5,type,session&255,session>>8,seq&255,seq>>8,total&255,total>>8,payload.length&255,payload.length>>8]);a.set(payload,HEADER);const c=crc32(a.subarray(0,a.length-4));for(let i=0;i<4;i++)a[a.length-4+i]=c>>>(8*i)&255;return a}
function parse(a){if(a.length<HEADER+4||a[0]!==0xa7||a[1]!==0x4c||a[2]!==5)return null;const len=a[10]|a[11]<<8;if(len>MAX||a.length!==HEADER+len+4)return null;const c=crc32(a.subarray(0,a.length-4));let given=0;for(let i=0;i<4;i++)given|=a[a.length-4+i]<<(8*i);if(c!==(given>>>0))return null;return {type:a[3],session:a[4]|a[5]<<8,seq:a[6]|a[7]<<8,total:a[8]|a[9]<<8,payload:a.slice(HEADER,-4)}}
function waveform(syms){const a=new Float32Array(syms.length*SPS);let phase=0;for(let k=0;k<syms.length;k++){const step=2*Math.PI*F[syms[k]]/SR;for(let j=0;j<SPS;j++){const fade=Math.min(1,j/24,(SPS-1-j)/24);a[k*SPS+j]=Math.sin(phase)*.67*Math.max(0,fade);phase+=step;if(phase>2*Math.PI)phase-=2*Math.PI}}return a}
function tone(a,start,sr){start=Math.round(start);const n=Math.round(sr*DUR),offset=Math.floor(n*.12),len=n-2*offset;let best=-1,idx=0,second=0;for(let t=0;t<4;t++){const w=2*Math.PI*F[t]/sr,co=2*Math.cos(w);let p=0,q=0;for(let i=0;i<len;i++){const v=a[start+offset+i]+co*p-q;q=p;p=v}const power=p*p+q*q-co*p*q;if(power>best){second=best;best=power;idx=t}else if(power>second)second=power}return {idx,confidence:best/(Math.max(0,second)+1e-7),power:best}}
function decodeWords(tones){const out=[];for(let i=0;i+5<tones.length;i+=6){let w=0;for(let j=0;j<6;j++)w=w<<2|tones[i+j];const b=unham(w);if(b===null)return null;out.push(b)}return Uint8Array.from(out)}
// Streaming scanner: finds sync using coarse phase search and checks packet CRC; resynchronizes on next packet.
class Decoder{constructor(onPacket,onStats){this.onPacket=onPacket;this.onStats=onStats||(()=>{});this.buffer=[];this.sr=SR;this.cursor=0;this.packets=0;this.fail=0;this.state='search';this.expected=0;this.start=0}
feed(samples,sr){if(this.sr!==sr){this.reset();this.sr=sr}for(let i=0;i<samples.length;i++)this.buffer.push(samples[i]);this.process()}
reset(){this.buffer=[];this.cursor=0;this.packets=0;this.fail=0;this.state='search';this.start=0}
process(){const per=this.sr*DUR,syncLen=SYNC.length*per;let steps=0;while(steps++<200){if(this.state==='search'){if(this.buffer.length-this.cursor<syncLen+per*2)break;let best=-1,bestAt=-1;const stride=Math.max(1,Math.floor(per/6));const end=Math.min(this.buffer.length-syncLen-per,this.cursor+per*28);for(let off=this.cursor;off<=end;off+=stride){let score=0;for(let j=0;j<SYNC.length;j++){const t=tone(this.buffer,off+j*per,this.sr);if(t.idx===SYNC[j])score+=Math.min(2,Math.log2(Math.max(1,t.confidence)));else score-=1.5}if(score>best){best=score;bestAt=off}}if(best>SYNC.length*.68){this.start=bestAt+syncLen;this.state='header'}else{this.cursor=Math.max(this.cursor+stride,end-per*2);this.trim();break}}
if(this.state==='header'){if(this.buffer.length<this.start+HEADER*6*per)break;const a=this.readBytes(this.start,HEADER,per);if(!a||a[0]!==0xa7||a[1]!==0x4c||a[2]!==5||(a[10]|a[11]<<8)>MAX){this.fail++;this.cursor=this.start-syncLen+per;this.state='search';this.trim();continue}this.expected=HEADER+(a[10]|a[11]<<8)+4;this.state='packet'}
if(this.state==='packet'){if(this.buffer.length<this.start+this.expected*6*per)break;const a=this.readBytes(this.start,this.expected,per),p=a&&parse(a);if(p){this.packets++;this.onPacket(p)}else this.fail++;this.cursor=this.start+this.expected*6*per;this.state='search';this.trim();this.onStats({packets:this.packets,failed:this.fail});continue}}
}
readBytes(start,count,per){const t=[];for(let i=0;i<count*6;i++)t.push(tone(this.buffer,start+i*per,this.sr).idx);return decodeWords(t)}
trim(){if(this.cursor>this.sr*2){const n=Math.floor(this.cursor);this.buffer.splice(0,n);this.cursor-=n;this.start-=n}}
}
return {SR,DUR,SPS,F,SYNC,MAX,HEADER,crc32,ham,unham,symbols,packet,parse,waveform,Decoder};})();
