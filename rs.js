'use strict';
// Systematic Reed-Solomon erasure coding over GF(256), primitive polynomial 0x11d.
// Each group has K data shards and R parity shards. CRC-rejected shards count as erasures.
const RS=(()=>{const exp=new Uint8Array(512),log=new Uint8Array(256);let x=1;for(let i=0;i<255;i++){exp[i]=x;log[x]=i;x<<=1;if(x&256)x^=0x11d}for(let i=255;i<512;i++)exp[i]=exp[i-255];
const mul=(a,b)=>a&&b?exp[log[a]+log[b]]:0,inv=a=>{if(!a)throw Error('Singular RS matrix');return exp[255-log[a]]};
function invert(matrix){const n=matrix.length,a=matrix.map((r,i)=>[...r,...Array.from({length:n},(_,j)=>+(i===j))]);for(let c=0;c<n;c++){let pivot=c;while(pivot<n&&!a[pivot][c])pivot++;if(pivot===n)throw Error('Singular matrix');[a[c],a[pivot]]=[a[pivot],a[c]];const v=inv(a[c][c]);for(let j=0;j<2*n;j++)a[c][j]=mul(a[c][j],v);for(let i=0;i<n;i++)if(i!==c&&a[i][c]){const factor=a[i][c];for(let j=0;j<2*n;j++)a[i][j]^=mul(factor,a[c][j])}}return a.map(r=>r.slice(n))}
function matrix(k,r){const v=Array.from({length:k+r},(_,i)=>Array.from({length:k},(_,j)=>j===0?1:exp[(log[i+1]*j)%255]));const top=invert(v.slice(0,k));return v.map(row=>top[0].map((_,j)=>row.reduce((s,z,t)=>s^mul(z,top[t][j]),0)))}
function encode(data,r){const k=data.length,n=data[0].length,m=matrix(k,r),result=data.map(a=>a.slice());for(let i=k;i<k+r;i++){const out=new Uint8Array(n);for(let j=0;j<k;j++)for(let b=0;b<n;b++)out[b]^=mul(m[i][j],data[j][b]);result.push(out)}return result}
function recover(shards,k,r){const have=[];for(let i=0;i<k+r;i++)if(shards[i])have.push(i);if(have.length<k)return null;const ids=have.slice(0,k),m=matrix(k,r),im=invert(ids.map(i=>m[i]));const size=shards[ids[0]].length;const data=Array.from({length:k},()=>new Uint8Array(size));for(let i=0;i<k;i++)for(let j=0;j<k;j++){const factor=im[i][j];if(!factor)continue;const src=shards[ids[j]];for(let b=0;b<size;b++)data[i][b]^=mul(factor,src[b])}return data}
return {encode,recover};})();
