function createBistuCrypto() {
    'use strict';
    /*!
@noble/ciphers 2.4.0; @noble/hashes 2.4.0
LICENSE-noble-ciphers.txt
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)
Copyright (c) 2016 Thomas Pornin <pornin@bolet.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

LICENSE-noble-hashes.txt
The MIT License (MIT)

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the “Software”), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
var BistuNoble=(()=>{var $=Object.defineProperty;var Nt=Object.getOwnPropertyDescriptor;var Ft=Object.getOwnPropertyNames;var $t=Object.prototype.hasOwnProperty;var zt=(t,e,n)=>e in t?$(t,e,{enumerable:!0,configurable:!0,writable:!0,value:n}):t[e]=n;var Pt=(t,e)=>{for(var n in e)$(t,n,{get:e[n],enumerable:!0})},Gt=(t,e,n,o)=>{if(e&&typeof e=="object"||typeof e=="function")for(let r of Ft(e))!$t.call(t,r)&&r!==n&&$(t,r,{get:()=>e[r],enumerable:!(o=Nt(e,r))||o.enumerable});return t};var Wt=t=>Gt($({},"__esModule",{value:!0}),t);var d=(t,e,n)=>zt(t,typeof e!="symbol"?e+"":e,n);var ge={};Pt(ge,{gcm:()=>Bt,pbkdf2Async:()=>kt,sha256:()=>Kt});function et(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"&&"BYTES_PER_ELEMENT"in t&&t.BYTES_PER_ELEMENT===1}var z=t=>t?`"${t}" `:"";function Vt(t,e=""){if(typeof t!="boolean")throw new TypeError(z(e)+"expected boolean, got type="+typeof t);return t}function P(t,e=""){if(typeof t!="number")throw new TypeError(z(e)+"expected number, got "+typeof t);if(!Number.isSafeInteger(t)||t<0)throw new RangeError(z(e)+"expected integer >= 0, got "+t);return t}function b(t,e,n=""){if(et(t)&&(e===void 0||t.length===e))return t;e!==void 0&&P(e,"length");let o=et(t),r=e!==void 0?` of length ${e}`:"",s=o?`length=${t.length}`:`type=${typeof t}`,f=z(n)+"expected Uint8Array"+r+", got "+s;throw o?new RangeError(f):new TypeError(f)}function G(t,e=!0){if(t.destroyed)throw new Error("hash was destroyed");if(e&&t.finished)throw new Error("digest() was already called")}function Yt(t,e){b(t,void 0,"output");let n=e.outputLen;if(!(t.length>=n))throw new RangeError('"output" expected length >= '+n)}function nt(t,e){if(Yt(t,e),!v(t))throw new Error("invalid output, must be aligned")}function xt(t){return new Uint8Array(t.buffer,t.byteOffset,t.byteLength)}function T(t){return new Uint32Array(t.buffer,t.byteOffset,Math.floor(t.byteLength/4))}function U(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function C(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}var O=new Uint8Array(new Uint32Array([287454020]).buffer)[0]===68;function ot(t){return t<<24&4278190080|t<<8&16711680|t>>>8&65280|t>>>24&255}var g=O?t=>t:t=>ot(t)>>>0;function qt(t){for(let e=0;e<t.length;e++)t[e]=ot(t[e]);return t}var R=O?t=>t:qt;function gt(t,e){if(t=b(t),e=b(e),t.length!==e.length)return!1;let n=0;for(let o=0;o<t.length;o++)n|=t[o]^e[o];return n===0}function rt(t,e,n){let o=e,r=n||(()=>[]),s=(i,c)=>o(c,...r(i)).update(i).digest(),f=o(new Uint8Array(t),...r(new Uint8Array(0)));return s.outputLen=f.outputLen,s.blockLen=f.blockLen,s.create=(i,...c)=>o(i,...c),s}var yt=(t,e)=>{function n(o,...r){if(b(o,void 0,"key"),t.nonceLength!==void 0){let h=r[0];b(h,t.varSizeNonce?void 0:t.nonceLength,"nonce")}let s=t.tagLength,f=t.nonceLength!==void 0?1:0;if(!t.withAAD){for(let h=f;h<r.length;h++)if(et(r[h]))throw new Error("AAD not supported")}t.withAAD&&r[f]!==void 0&&b(r[f],void 0,"AAD");let i=e(o,...r),c=(h,a)=>{if(a!==void 0){if(h!==2)throw new Error("cipher output not supported");b(a,void 0,"output")}},u=!1;return{encrypt(h,a){if(u)throw new Error("cannot encrypt() twice with same key + nonce");return u=!0,b(h,void 0,"data"),c(i.encrypt.length,a),i.encrypt(h,a)},decrypt(h,a){if(b(h,void 0,"data"),s&&h.length<s)throw new Error('"ciphertext" expected length >= tagLength='+s);return c(i.decrypt.length,a),i.decrypt(h,a)}}}return Object.assign(n,t),n};function bt(t,e,n=!0){if(e===void 0)return new Uint8Array(t);if(b(e,t,"output"),n&&!v(e))throw new Error("invalid output, must be aligned");return e}function wt(t,e,n){P(t),P(e),Vt(n);let o=new Uint8Array(16),r=C(o);return r.setBigUint64(0,BigInt(e),n),r.setBigUint64(8,BigInt(t),n),o}function v(t){return t.byteOffset%4===0}function _(t){return Uint8Array.from(b(t))}var I=16,Et=new Uint8Array(16),N=T(Et),Xt=225,Zt=(t,e,n,o)=>{let r=o&1;return{s3:n<<31|o>>>1,s2:e<<31|n>>>1,s1:t<<31|e>>>1,s0:t>>>1^Xt<<24&-(r&1)}},W=t=>(t>>>0&255)<<24|(t>>>8&255)<<16|(t>>>16&255)<<8|t>>>24&255|0;var Jt=t=>t>64*1024?8:t>1024?4:2,st=class{constructor(e,n){d(this,"blockLen",I);d(this,"outputLen",I);d(this,"s0",0);d(this,"s1",0);d(this,"s2",0);d(this,"s3",0);d(this,"finished",!1);d(this,"destroyed",!1);d(this,"t");d(this,"W");d(this,"windowSize");b(e,16,"key"),e=_(e);let o=C(e),r=o.getUint32(0,!1),s=o.getUint32(4,!1),f=o.getUint32(8,!1),i=o.getUint32(12,!1),c=[];for(let p=0;p<128;p++)c.push({s0:W(r),s1:W(s),s2:W(f),s3:W(i)}),{s0:r,s1:s,s2:f,s3:i}=Zt(r,s,f,i);let u=Jt(n||1024);if(![1,2,4,8].includes(u))throw new Error("ghash: invalid window size, expected 2, 4 or 8");this.W=u;let h=128/u,a=this.windowSize=2**u,x=[];for(let p=0;p<h;p++)for(let y=0;y<a;y++){let w=0,E=0,m=0,k=0;for(let A=0;A<u;A++){if(!(y>>>u-A-1&1))continue;let{s0:tt,s1:Mt,s2:jt,s3:Rt}=c[u*p+A];w^=tt,E^=Mt,m^=jt,k^=Rt}x.push({s0:w,s1:E,s2:m,s3:k})}this.t=x}_updateBlock(e,n,o,r){e^=this.s0,n^=this.s1,o^=this.s2,r^=this.s3;let{W:s,t:f,windowSize:i}=this,c=0,u=0,l=0,h=0,a=(1<<s)-1,x=0;for(let p of[e,n,o,r])for(let y=0;y<4;y++){let w=p>>>8*y&255;for(let E=8/s-1;E>=0;E--){let m=w>>>s*E&a,{s0:k,s1:A,s2:j,s3:tt}=f[x*i+m];c^=k,u^=A,l^=j,h^=tt,x+=1}}this.s0=c,this.s1=u,this.s2=l,this.s3=h}update(e){G(this),b(e),e=_(e);let n=T(e),o=Math.floor(e.length/I),r=e.length%I;for(let s=0;s<o;s++)this._updateBlock(g(n[s*4+0]),g(n[s*4+1]),g(n[s*4+2]),g(n[s*4+3]));return r&&(Et.set(e.subarray(o*I)),this._updateBlock(g(N[0]),g(N[1]),g(N[2]),g(N[3])),U(N)),this}destroy(){this.destroyed=!0;let{t:e}=this;for(let n of e)n.s0=0,n.s1=0,n.s2=0,n.s3=0}digestInto(e){G(this),nt(e,this),this.finished=!0;let{s0:n,s1:o,s2:r,s3:s}=this,f=T(e);f[0]=n,f[1]=o,f[2]=r,f[3]=s,O||R(f.subarray(0,I/4))}digest(){let e=new Uint8Array(I);return this.digestInto(e),this.destroy(),e}};var ct=rt(16,(t,e)=>new st(t,e),t=>[t.length]);var ft=16,Qt=4,V=new Uint8Array(ft);var te=283;function ee(t){if(![16,24,32].includes(t.length))throw new Error('"aes key" expected Uint8Array of length 16/24/32, got length='+t.length)}function ut(t){return t<<1^te&-(t>>7)}function mt(t,e){let n=0;for(;e>0;e>>=1)n^=t&-(e&1),t=ut(t);return n}var ne=(()=>{let t=new Uint8Array(256);for(let n=0,o=1;n<256;n++,o^=ut(o))t[n]=o;let e=new Uint8Array(256);e[0]=99;for(let n=0;n<255;n++){let o=t[255-n];o|=o<<8,e[t[n]]=(o^o>>4^o>>5^o>>6^o>>7^99)&255}return U(t),e})();var oe=t=>t<<24|t>>>8,it=t=>t<<8|t>>>24;function re(t,e){if(t.length!==256)throw new Error("wrong sbox length");let n=new Uint32Array(256).map((u,l)=>e(t[l])),o=n.map(it),r=o.map(it),s=r.map(it),f=new Uint32Array(256*256),i=new Uint32Array(256*256),c=new Uint16Array(256*256);for(let u=0;u<256;u++)for(let l=0;l<256;l++){let h=u*256+l;f[h]=n[u]^o[l],i[h]=r[u]^s[l],c[h]=t[u]<<8|t[l]}return{sbox:t,sbox2:c,T0:n,T1:o,T2:r,T3:s,T01:f,T23:i}}var Lt=re(ne,t=>mt(t,3)<<24|t<<16|t<<8|mt(t,2));var se=(()=>{let t=new Uint8Array(16);for(let e=0,n=1;e<16;e++,n=ut(n))t[e]=n;return t})();function ce(t){b(t);let e=t.length;ee(t);let{sbox2:n}=Lt,o=[];(!O||!v(t))&&o.push(t=_(t));let r=R(T(t)),s=r.length,f=c=>F(n,c,c,c,c),i=new Uint32Array(e+28);i.set(r);for(let c=s;c<i.length;c++){let u=i[c-1];c%s===0?u=f(oe(u))^se[c/s-1]:s>6&&c%s===4&&(u=f(u)),i[c]=i[c-s]^u}return U(...o),i}function Y(t,e,n,o,r,s){return t[n<<8&65280|o>>>8&255]^e[r>>>8&65280|s>>>24&255]}function F(t,e,n,o,r){return t[e&255|n&65280]|t[o>>>16&255|r>>>16&65280]<<16}function At(t,e,n,o,r){let{sbox2:s,T01:f,T23:i}=Lt,c=0;e^=t[c++],n^=t[c++],o^=t[c++],r^=t[c++];let u=t.length/4-2;for(let p=0;p<u;p++){let y=t[c++]^Y(f,i,e,n,o,r),w=t[c++]^Y(f,i,n,o,r,e),E=t[c++]^Y(f,i,o,r,e,n),m=t[c++]^Y(f,i,r,e,n,o);e=y,n=w,o=E,r=m}let l=t[c++]^F(s,e,n,o,r),h=t[c++]^F(s,n,o,r,e),a=t[c++]^F(s,o,r,e,n),x=t[c++]^F(s,r,e,n,o);return{s0:l,s1:h,s2:a,s3:x}}function q(t,e,n,o,r){b(n,ft,"nonce"),b(o),r=bt(o.length,r);let s=n,f=T(s),i=C(s),c=T(o),u=T(r),l=e?0:12,h=o.length,a=i.getUint32(l,e);for(let p=0;p+4<=c.length;p+=4){let{s0:y,s1:w,s2:E,s3:m}=At(t,g(f[0]),g(f[1]),g(f[2]),g(f[3]));u[p+0]=c[p+0]^g(y),u[p+1]=c[p+1]^g(w),u[p+2]=c[p+2]^g(E),u[p+3]=c[p+3]^g(m),a=a+1>>>0,i.setUint32(l,a,e)}let x=ft*Math.floor(c.length/Qt);if(x<h){let{s0:p,s1:y,s2:w,s3:E}=At(t,g(f[0]),g(f[1]),g(f[2]),g(f[3])),m=new Uint32Array([p,y,w,E]);R(m);let k=xt(m);for(let A=x,j=0;A<h;A++,j++)r[A]=o[A]^k[j];U(m)}return r}function ie(t,e,n,o,r){let s=r?r.length:0,f=t.create(n,o.length+s);r&&f.update(r);let i=wt(8*o.length,8*s,e);f.update(o),f.update(i);let c=f.digest();return U(i),c}var Bt=yt({blockSize:16,nonceLength:12,tagLength:16,withAAD:!0,varSizeNonce:!0},function(e,n,o){if(n.length<8)throw new Error("aes/gcm: invalid nonce length");let r=16;function s(i,c,u){let l=ie(ct,!1,i,u,o);for(let h=0;h<c.length;h++)l[h]^=c[h];return l}function f(){let i=ce(e),c=V.slice(),u=V.slice();if(q(i,!1,u,u,c),n.length===12)u.set(n);else{let h=V.slice();C(h).setBigUint64(8,BigInt(n.length*8),!1);let x=ct.create(c).update(n).update(h);x.digestInto(u),x.destroy()}let l=q(i,!1,u,V);return{xk:i,authKey:c,counter:u,tagMask:l}}return{encrypt(i){let{xk:c,authKey:u,counter:l,tagMask:h}=f(),a=new Uint8Array(i.length+r),x=[c,u,l,h];v(i)||x.push(i=_(i)),q(c,!1,l,i,a.subarray(0,i.length));let p=s(u,h,a.subarray(0,a.length-r));return x.push(p),a.set(p,i.length),U(...x),a},decrypt(i){let{xk:c,authKey:u,counter:l,tagMask:h}=f(),a=[c,u,h,l];v(i)||a.push(i=_(i));let x=i.subarray(0,-r),p=i.subarray(-r),y=s(u,h,x);if(a.push(y),!gt(y,p))throw U(...a),new Error("aes-gcm: invalid tag");let w=q(c,!1,l,x);return U(...a),w}}});function Ut(t){return t instanceof Uint8Array||ArrayBuffer.isView(t)&&t.constructor.name==="Uint8Array"&&"BYTES_PER_ELEMENT"in t&&t.BYTES_PER_ELEMENT===1}var ht=t=>t?`"${t}" `:"";function S(t,e=""){if(typeof t!="number")throw new TypeError(ht(e)+"expected number, got "+typeof t);if(!Number.isSafeInteger(t)||t<0)throw new RangeError(ht(e)+"expected integer >= 0, got "+t);return t}function D(t,e,n=""){if(Ut(t)&&(e===void 0||t.length===e))return t;e!==void 0&&S(e,"length");let o=Ut(t),r=e!==void 0?` of length ${e}`:"",s=o?`length=${t.length}`:`type=${typeof t}`,f=ht(n)+"expected Uint8Array"+r+", got "+s;throw o?new RangeError(f):new TypeError(f)}function X(t){if(typeof t!="function"||typeof t.create!="function")throw new TypeError("expected hash wrapped by utils.createHasher");if(S(t.outputLen),S(t.blockLen),t.outputLen<1||t.blockLen<1)throw new Error("hash blockLen / outputLen must be >= 1")}var fe=(t,e)=>{if(t===null||typeof t!="object"||Array.isArray(t))throw new TypeError((e==="object"?"":`"${e}" `)+"expected object, got type="+typeof t)},Tt=(t,e)=>{fe(t,e);let n=Object.getPrototypeOf(t);if(n!==Object.prototype&&n!==null)throw new TypeError(`"${e}" expected plain object`);if(Object.hasOwn(t,"__proto__"))throw new TypeError(`"${e}.__proto__" is not allowed`)};function K(t,e=!0){if(t.destroyed)throw new Error("hash was destroyed");if(e&&t.finished)throw new Error("digest() was already called")}function Z(t,e){D(t,void 0,"output");let n=e.outputLen;if(!(t.length>=n))throw new RangeError('"output" expected length >= '+n)}function L(...t){for(let e=0;e<t.length;e++)t[e].fill(0)}function M(t){return new DataView(t.buffer,t.byteOffset,t.byteLength)}function B(t,e){return t<<32-e|t>>>e}function ue(t){let e=globalThis;if(typeof e.scheduler?.yield=="function"){let n=e.scheduler.yield();return t&&n.catch(t),n}return new Promise(n=>e.setTimeout(n,0))}async function St(t,e,n,o){if(S(t,"iters"),S(e,"tick"),typeof n!="function")throw new TypeError("callback must be a function");let r=Date.now();for(let s=0;s<t;s++){n(s);let f=Date.now()-r;f>=0&&f<e||(await ue(o),r=Date.now())}}function he(t){if(typeof t!="string")throw new TypeError("string expected");let e=new TextEncoder().encode(t);try{return new Uint8Array(e)}finally{L(e)}}function at(t,e=""){return typeof t=="string"?he(t):D(t,void 0,e)}function lt(t,e,n="opts"){return Tt(t,"defaults"),e!==void 0&&Tt(e,n),Object.assign(Object.create(null),t,e)}function Ht(t,e={}){if(typeof t!="function")throw new TypeError('"hashCons" expected function, got type='+typeof t);e=lt({},e,"info");let n=(r,s)=>t(s).update(r).digest(),o=t(void 0);return n.outputLen=o.outputLen,n.blockLen=o.blockLen,n.canXOF=o.canXOF,n.create=r=>t(r),Object.assign(n,e),Object.freeze(n)}var _t=t=>({oid:Uint8Array.from([6,9,96,134,72,1,101,3,4,2,t])});var J=class{constructor(e,n){d(this,"oHash");d(this,"iHash");d(this,"blockLen");d(this,"outputLen");d(this,"canXOF",!1);d(this,"finished",!1);d(this,"destroyed",!1);if(X(e),D(n,void 0,"key"),this.iHash=e.create(),typeof this.iHash.update!="function")throw new Error("expected Hash instance");this.blockLen=this.iHash.blockLen,this.outputLen=this.iHash.outputLen;let o=this.blockLen,r=new Uint8Array(o);r.set(n.length>o?e.create().update(n).digest():n);for(let s=0;s<r.length;s++)r[s]^=54;this.iHash.update(r),this.oHash=e.create();for(let s=0;s<r.length;s++)r[s]^=106;this.oHash.update(r),L(r)}update(e){return K(this),this.iHash.update(e),this}digestInto(e){K(this),Z(e,this),this.finished=!0;let n=e.subarray(0,this.outputLen);this.iHash.digestInto(n),this.oHash.update(n),this.oHash.digestInto(n),this.destroy()}digest(){let e=new Uint8Array(this.oHash.outputLen);return this.digestInto(e),e}_cloneInto(e){e||(e=Object.create(Object.getPrototypeOf(this),{}));let{oHash:n,iHash:o,finished:r,destroyed:s,blockLen:f,outputLen:i,canXOF:c}=this;return e=e,e.finished=r,e.destroyed=s,e.blockLen=f,e.outputLen=i,e.canXOF=c,e.oHash=n._cloneInto(e.oHash),e.iHash=o._cloneInto(e.iHash),e}clone(){return this._cloneInto()}destroy(){this.destroyed=!0,this.oHash.destroy(),this.iHash.destroy()}},It=(()=>{let t=((e,n,o)=>new J(e,n).update(o).digest());return t.create=(e,n)=>new J(e,n),t})();function ae(t,e,n,o){X(t);let r=lt({dkLen:32,asyncTick:10},o),{c:s,dkLen:f,asyncTick:i}=r;if(S(s,"c"),S(f,"dkLen"),S(i,"asyncTick"),s<1)throw new Error('"c" (iterations) must be >= 1');if(f<1)throw new Error('"dkLen" must be >= 1');if(f>(2**32-1)*t.outputLen)throw new Error("derived key too long");let c=at(e,"password");try{let u=at(n,"salt");try{let l=new Uint8Array(f),{iHash:h,oHash:a,outputLen:x}=It.create(t,c),p=new Uint8Array(x),y=le(h,a,u,p);return{c:s,dkLen:f,asyncTick:i,DK:l,outputLen:x,eng:y}}finally{typeof n=="string"&&L(u)}}finally{typeof e=="string"&&L(c)}}function le(t,e,n,o){let r=new Uint8Array(4),s=M(r),f=t._cloneInto().update(n),i=e._cloneInto(),c=t._cloneInto,u=e._cloneInto;return{u1:(l,h)=>{s.setInt32(0,l,!1),f._cloneInto(i).update(r).digestInto(o),e._cloneInto(i).update(o).digestInto(o),h.set(o.subarray(0,h.length))},rounds:(l,h)=>{for(let a=1;a<l;a++){c.call(t,i).update(o).digestInto(o),u.call(e,i).update(o).digestInto(o);for(let x=0;x<h.length;x++)h[x]^=o[x]}},output:l=>(t.destroy(),e.destroy(),f.destroy(),i.destroy(),L(o),l)}}async function kt(t,e,n,o){let{c:r,dkLen:s,asyncTick:f,DK:i,outputLen:c,eng:u}=ae(t,e,n,o),l=()=>{u.output(i),L(i)};for(let h=1,a=0;a<s;h++,a+=c){let x=i.subarray(a,a+c);u.u1(h,x),await St(r-1,f,()=>{u.rounds(2,x)},l)}return u.output(i)}var de=t=>t/2**32|0,pe=t=>t>>>0;function Ct(t,e,n,o){let r=de(n),s=pe(n);t.setUint32(e,o?s:r,o),t.setUint32(e+4,o?r:s,o)}function Ot(t,e,n){return t&e^~t&n}function vt(t,e,n){return t&e^t&n^e&n}var Q=class{constructor(e,n,o,r){d(this,"blockLen");d(this,"outputLen");d(this,"canXOF",!1);d(this,"padOffset");d(this,"isLE");d(this,"buffer");d(this,"view");d(this,"finished",!1);d(this,"length",0);d(this,"pos",0);d(this,"destroyed",!1);this.blockLen=e,this.outputLen=n,this.padOffset=o,this.isLE=r,this.buffer=new Uint8Array(e),this.view=M(this.buffer)}update(e){K(this),D(e);let{view:n,buffer:o,blockLen:r}=this,s=e.length,f=!1;for(let i=0;i<s;){let c=Math.min(r-this.pos,s-i);if(c===r){let u=M(e);for(;r<=s-i;i+=r)this.process(u,i);f=!0;continue}o.set(i===0&&c===s?e:e.subarray(i,i+c),this.pos),this.pos+=c,i+=c,this.pos===r&&(this.process(n,0),this.pos=0,f=!0)}return this.length+=e.length,f&&this.roundClean(),this}digestInto(e){K(this),Z(e,this),this.finished=!0;let{buffer:n,view:o,blockLen:r,isLE:s}=this,{pos:f}=this;n[f++]=128,n.fill(0,f),this.padOffset>r-f&&(this.process(o,0),n.fill(0)),Ct(o,r-8,this.length*8,s),this.process(o,0),this.roundClean();let i=e===n?o:M(e),c=this.outputLen,u=c/4,l=this.get();if(c%4||u>l.length)throw new Error("invalid outputLen");for(let h=0;h<u;h++)i.setUint32(4*h,l[h],s)}digest(){let{buffer:e,outputLen:n}=this;this.digestInto(e);let o=e.slice(0,n);return this.destroy(),o}_cloneIntoMeta(e){let{buffer:n,length:o,finished:r,destroyed:s,pos:f}=this;return e.destroyed=s,e.finished=r,e.length=o,e.pos=f,f&&e.buffer.set(n),e}clone(){return this._cloneInto()}},Dt=Uint32Array.from([1779033703,3144134277,1013904242,2773480762,1359893119,2600822924,528734635,1541459225]);var xe=Uint32Array.from([1116352408,1899447441,3049323471,3921009573,961987163,1508970993,2453635748,2870763221,3624381080,310598401,607225278,1426881987,1925078388,2162078206,2614888103,3248222580,3835390401,4022224774,264347078,604807628,770255983,1249150122,1555081692,1996064986,2554220882,2821834349,2952996808,3210313671,3336571891,3584528711,113926993,338241895,666307205,773529912,1294757372,1396182291,1695183700,1986661051,2177026350,2456956037,2730485921,2820302411,3259730800,3345764771,3516065817,3600352804,4094571909,275423344,430227734,506948616,659060556,883997877,958139571,1322822218,1537002063,1747873779,1955562222,2024104815,2227730452,2361852424,2428436474,2756734187,3204031479,3329325298]),H=new Uint32Array(64),dt=class extends Q{constructor(n,o){super(64,n,8,!1);d(this,"A",0);d(this,"B",0);d(this,"C",0);d(this,"D",0);d(this,"E",0);d(this,"F",0);d(this,"G",0);d(this,"H",0);this.A=o[0]|0,this.B=o[1]|0,this.C=o[2]|0,this.D=o[3]|0,this.E=o[4]|0,this.F=o[5]|0,this.G=o[6]|0,this.H=o[7]|0}get(){let{A:n,B:o,C:r,D:s,E:f,F:i,G:c,H:u}=this;return[n,o,r,s,f,i,c,u]}set(n,o,r,s,f,i,c,u){this.A=n|0,this.B=o|0,this.C=r|0,this.D=s|0,this.E=f|0,this.F=i|0,this.G=c|0,this.H=u|0}_cloneInto(n){return(n||(n=new this.constructor)).set(...this.get()),this._cloneIntoMeta(n)}process(n,o){for(let a=0;a<16;a++,o+=4)H[a]=n.getUint32(o,!1);for(let a=16;a<64;a++){let x=H[a-15],p=H[a-2],y=B(x,7)^B(x,18)^x>>>3,w=B(p,17)^B(p,19)^p>>>10;H[a]=w+H[a-7]+y+H[a-16]|0}let{A:r,B:s,C:f,D:i,E:c,F:u,G:l,H:h}=this;for(let a=0;a<64;a++){let x=B(c,6)^B(c,11)^B(c,25),p=h+x+Ot(c,u,l)+xe[a]+H[a]|0,w=(B(r,2)^B(r,13)^B(r,22))+vt(r,s,f)|0;h=l,l=u,u=c,c=i+p|0,i=f,f=s,s=r,r=p+w|0}r=r+this.A|0,s=s+this.B|0,f=f+this.C|0,i=i+this.D|0,c=c+this.E|0,u=u+this.F|0,l=l+this.G|0,h=h+this.H|0,this.set(r,s,f,i,c,u,l,h)}roundClean(){L(H)}destroy(){this.destroyed=!0,this.set(0,0,0,0,0,0,0,0),L(this.buffer)}},pt=class extends dt{constructor(){super(32,Dt)}};var Kt=Ht(()=>new pt,_t(1));return Wt(ge);})();

    const ITERATIONS = 600000, MAX_BYTES = 128 * 1024 * 1024;
    const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal:true});
    const nativeKeys = new WeakMap(), usedNonces = new WeakMap();
    function bytes(value) {
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
        if (Object.prototype.toString.call(value) === '[object ArrayBuffer]') return new Uint8Array(value);
        throw new Error('加密数据必须为字节数组。');
    }
    function base64(value) {
        const data = bytes(value); let text = '';
        for (let index = 0; index < data.length; index += 32768) text += String.fromCharCode(...data.subarray(index,index + 32768));
        return btoa(text);
    }
    function unbase64(value, limit = MAX_BYTES + 16) {
        if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || value.length % 4) throw new Error('加密数据编码无效。');
        const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
        // Repeated regex groups can exhaust the browser regexp stack on an
        // otherwise valid multi-megabyte reader. Scan characters in linear space.
        for (let index = 0; index < value.length - padding; index++) {
            const code = value.charCodeAt(index);
            if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) throw new Error('加密数据编码无效。');
        }
        const data = Uint8Array.from(atob(value),character => character.charCodeAt(0));
        if (data.length > limit || base64(data) !== value) throw new Error('加密数据长度或编码无效。');
        return data;
    }
    function random(length) {
        if (!globalThis.crypto?.getRandomValues) throw new Error('当前环境没有安全随机数，无法导出密码保护文件。');
        return globalThis.crypto.getRandomValues(new Uint8Array(length));
    }
    function validateConfig(config) {
        if (!config || config.version !== 1 || config.kdf !== 'PBKDF2-SHA256' || config.cipher !== 'AES-256-GCM' || config.iterations !== ITERATIONS || unbase64(config.salt,16).length !== 16) throw new Error('不支持或已损坏的密码保护参数。');
        return config;
    }
    function validateKey(key) { if (!ArrayBuffer.isView(key) || key.byteLength !== 32) throw new Error('AES-256 密钥无效。'); return bytes(key); }
    async function deriveKey(password, config) {
        validateConfig(config);
        if (typeof password !== 'string' || !password.length || password.length > 256) throw new Error('请输入正确的导出密码。');
        const secret = encoder.encode(password), salt = unbase64(config.salt,16);
        try {
            if (globalThis.crypto?.subtle) {
                const material = await crypto.subtle.importKey('raw',secret,'PBKDF2',false,['deriveBits']);
                return new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},material,256));
            }
            return await BistuNoble.pbkdf2Async(BistuNoble.sha256,secret,salt,{c:ITERATIONS,dkLen:32,asyncTick:8});
        } finally { secret.fill(0); }
    }
    async function createSession(password) {
        if (typeof password !== 'string' || password.length < 4 || password.length > 256) throw new Error('导出密码须为 4–256 个字符。');
        const config = {version:1,kdf:'PBKDF2-SHA256',iterations:ITERATIONS,salt:base64(random(16)),cipher:'AES-256-GCM'};
        return {key:await deriveKey(password,config),config};
    }
    async function nativeKey(key) {
        let promise = nativeKeys.get(key);
        if (!promise) { promise = crypto.subtle.importKey('raw',validateKey(key),{name:'AES-GCM'},false,['encrypt','decrypt']); nativeKeys.set(key,promise); }
        return promise;
    }
    function aadBytes(aad) { if (typeof aad !== 'string' || !aad.length || aad.length > 2000) throw new Error('加密用途标识无效。'); return encoder.encode(aad); }
    async function encryptBytes(value, key, aad) {
        const data = bytes(value), rawKey = validateKey(key), additionalData = aadBytes(aad);
        if (data.byteLength > MAX_BYTES) throw new Error('单份加密内容超过支持的大小。');
        let seen = usedNonces.get(key); if (!seen) { seen = new Set(); usedNonces.set(key,seen); }
        if (seen.size >= 1000000) throw new Error('本次导出加密文件过多，请创建新的加密会话。');
        let iv, ivText;
        for (let attempt = 0; attempt < 8; attempt++) { iv = random(12); ivText = base64(iv); if (!seen.has(ivText)) break; }
        if (seen.has(ivText)) throw new Error('安全随机数重复，已停止加密。');
        seen.add(ivText);
        const cipher = globalThis.crypto?.subtle
            ? new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData,tagLength:128},await nativeKey(key),data))
            : BistuNoble.gcm(rawKey,iv,additionalData).encrypt(data);
        return {iv:ivText,data:base64(cipher)};
    }
    async function decryptBytes(record, key, aad) {
        const rawKey = validateKey(key), additionalData = aadBytes(aad);
        const iv = unbase64(record?.iv,12), data = unbase64(record?.data);
        if (iv.length !== 12 || data.length < 16) throw new Error('加密内容无效或不完整。');
        try {
            return globalThis.crypto?.subtle
                ? new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData,tagLength:128},await nativeKey(key),data))
                : BistuNoble.gcm(rawKey,iv,additionalData).decrypt(data);
        } catch (_) { throw new Error('密码错误，或加密文件已损坏。'); }
    }
    function validateEnvelope(envelope, expectedPurpose) {
        if (!envelope || envelope.format !== 'bistu-encrypted' || envelope.version !== 1 || !['reader','state','report'].includes(envelope.purpose) || expectedPurpose && envelope.purpose !== expectedPurpose) throw new Error('加密文件类型不匹配。');
        validateConfig(envelope.crypto); return envelope;
    }
    async function encryptText(text, session, purpose) {
        if (typeof text !== 'string' || !['reader','state','report'].includes(purpose)) throw new Error('加密文本或用途无效。');
        validateConfig(session.config);
        return {format:'bistu-encrypted',version:1,crypto:{...session.config},purpose,...await encryptBytes(encoder.encode(text),session.key,'bistu-envelope:1:' + purpose)};
    }
    async function decryptText(envelope, password, expectedPurpose) {
        validateEnvelope(envelope,expectedPurpose);
        const key = await deriveKey(password,envelope.crypto);
        try { return {text:decoder.decode(await decryptBytes(envelope,key,'bistu-envelope:1:' + envelope.purpose)),key,config:{...envelope.crypto}}; }
        catch (error) { key.fill(0); throw error; }
    }
    return {createSession,deriveKey,encryptBytes,decryptBytes,encryptText,decryptText,validateEnvelope,base64,unbase64};
}
