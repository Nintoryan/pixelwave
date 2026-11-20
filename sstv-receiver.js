(()=>{
'use strict';
const $=id=>document.getElementById(id);
let ctx,stream,source,processor,recording=false,parts=[],total=0,sampleRate=48000;
const msg=s=>$('rxStatus').textContent=s;
async function cleanup(){recording=false;try{processor?.disconnect();source?.disconnect();}catch{}stream?.getTracks().forEach(t=>t.stop());try{await ctx?.close()}catch{}processor=source=stream=ctx=null;$('listen').disabled=false;$('stopListen').disabled=true;}
$('listen').onclick=async()=>{try{
stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}});
ctx=new (window.AudioContext||window.webkitAudioContext)();await ctx.resume();sampleRate=ctx.sampleRate;
source=ctx.createMediaStreamSource(stream);processor=ctx.createScriptProcessor(4096,1,1);parts=[];total=0;recording=true;
processor.onaudioprocess=e=>{if(recording){const a=e.inputBuffer.getChannelData(0);parts.push(new Float32Array(a));total+=a.length;if(total/sampleRate>65){msg('Достигнут предел 65 секунд, декодируй запись');cleanup();$('decode').disabled=false}}e.outputBuffer.getChannelData(0).fill(0)};
source.connect(processor);processor.connect(ctx.destination);$('listen').disabled=true;$('stopListen').disabled=false;$('decode').disabled=true;$('save').disabled=true;msg('Идёт запись. Включи Robot36 на втором устройстве…');
}catch(e){msg('Ошибка микрофона: '+e.message);await cleanup()}};
$('stopListen').onclick=async()=>{await cleanup();$('decode').disabled=total<sampleRate*3;msg('Записано '+(total/sampleRate).toFixed(1)+' с. Нажми «Декодировать».')};
// Estimate instantaneous tone frequency by interpolating rising zero crossings in a centered window.
// Works with speech-band SSTV tones, tolerates arbitrary sample rates and mild room noise.
function estimate(a,sr,center,ms=3.5){const half=Math.round(sr*ms/2000),lo=Math.max(1,Math.round(center)-half),hi=Math.min(a.length-1,Math.round(center)+half);let last=-1,count=0,sum=0,energy=0;for(let i=lo;i<=hi;i++){const v=a[i];energy+=v*v;if(a[i-1]<0&&v>=0){const crossing=i-1+(-a[i-1])/(v-a[i-1]+1e-15);if(last>=0){const d=crossing-last;if(d>sr/2700&&d<sr/850){sum+=d;count++}}last=crossing}}return count>=2&&energy/(hi-lo+1)>0.000005?sr*count/sum:NaN}
function median(a){const v=a.filter(Number.isFinite).sort((x,y)=>x-y);return v.length?v[Math.floor(v.length/2)]:NaN}
function syncScore(a,sr,t){const vals=[];for(let k=1;k<=5;k++)vals.push(estimate(a,sr,(t+k*.0013)*sr,2.5));const f=median(vals);return Number.isFinite(f)?Math.abs(f-1200):9999}
function findSync(a,sr,from,to,step=.001){let best=Infinity,bestT=-1;for(let t=Math.max(0,from);t<Math.min(to,a.length/sr-.02);t+=step){const score=syncScore(a,sr,t);if(score<best){best=score;bestT=t}}return best<125?bestT:-1}
function mapTone(f){return Number.isFinite(f)?Math.max(0,Math.min(255,Math.round((f-1500)*255/800))):128}
function ycc(y,cb,cr){const r=y+1.402*(cr-128),g=y-.344136*(cb-128)-.714136*(cr-128),b=y+1.772*(cb-128);return [Math.max(0,Math.min(255,r)),Math.max(0,Math.min(255,g)),Math.max(0,Math.min(255,b))]}
const sleep=()=>new Promise(r=>setTimeout(r,0));
$('decode').onclick=async()=>{
$('decode').disabled=true;msg('Анализ звука…');try{
const a=new Float32Array(total);let off=0;for(const p of parts){a.set(p,off);off+=p.length}const sr=sampleRate;
// Robot36 VIS header: 300ms 1900, 10ms 1200, 300ms 1900, 30ms 1200,
// then 30ms start bit, seven 30ms data bits, parity and 30ms stop.
// Find first 9ms horizontal sync after VIS. Try candidate syncs and lock on 150ms cadence.
let bestStart=-1,bestQuality=-1;
for(let t=.65;t<Math.min(4,a.length/sr-.5);t+=.004){if(syncScore(a,sr,t)>110)continue;let quality=0;for(let row=1;row<6;row++){const pred=t+row*.15;let min=999;for(let d=-.006;d<=.006;d+=.002)min=Math.min(min,syncScore(a,sr,pred+d));if(min<130)quality++}if(quality>bestQuality){bestQuality=quality;bestStart=t}if(quality===5)break}
if(bestStart<0||bestQuality<3)throw Error('Не найдена синхронизация Robot36. Запиши сигнал с самого начала, увеличь громкость и попробуй снова.');
// A line starts with 9ms 1200Hz sync, 3ms porch, 88ms Y, 4.5ms separator,
// 44ms Cr/Cb and 1.5ms trailing porch. Alternating chroma rows reconstruct color.
const Y=new Uint8Array(320*240),C1=new Uint8Array(160*240),C2=new Uint8Array(160*240);C1.fill(128);C2.fill(128);
let valid=0,prev=bestStart;
for(let row=0;row<240;row++){
const pred=bestStart+row*.15;let line=pred;if(row>0){const found=findSync(a,sr,Math.max(pred-.006,prev+.138),Math.min(pred+.007,prev+.164),.001);if(found>=0)line=found}prev=line;
if((line+.15)*sr>=a.length)break;
const yStart=line+.012;for(let x=0;x<320;x++){const t=yStart+(x+.5)*.088/320;Y[row*320+x]=mapTone(estimate(a,sr,t*sr,2.7))}
const cStart=line+.1045;for(let x=0;x<160;x++){const t=cStart+(x+.5)*.044/160;const val=mapTone(estimate(a,sr,t*sr,2.7));(row%2===0?C2:C1)[row*160+x]=val}valid++;
if(row%8===0){$('rxProgress').value=100*row/240;msg('Декодирование '+row+'/240 строк…');await sleep()}
}
if(valid<25)throw Error('Слишком короткая запись. Нужно примерно 37 секунд после заголовка.');
const canvas=$('received'),g=canvas.getContext('2d'),out=g.createImageData(320,240);
for(let row=0;row<valid;row++){for(let x=0;x<320;x++){
const ci=row*160+(x>>1);let cb,cr;
if(row%2===0){cr=C2[ci];cb=row+1<valid?C1[(row+1)*160+(x>>1)]:row>0?C1[(row-1)*160+(x>>1)]:128}
else{cb=C1[ci];cr=C2[(row-1)*160+(x>>1)]}
const rgb=ycc(Y[row*320+x],cb,cr),i=(row*320+x)*4;out.data[i]=rgb[0];out.data[i+1]=rgb[1];out.data[i+2]=rgb[2];out.data[i+3]=255;
}}g.putImageData(out,0,0);$('rxProgress').value=100*valid/240;$('save').disabled=false;msg('Декодировано '+valid+'/240 строк. Возможны полосы из-за акустических помех.');
}catch(e){msg('Ошибка: '+e.message)}finally{$('decode').disabled=false}
};
$('save').onclick=()=>{const a=document.createElement('a');a.download='robot36-received.png';a.href=$('received').toDataURL('image/png');a.click()};
})();