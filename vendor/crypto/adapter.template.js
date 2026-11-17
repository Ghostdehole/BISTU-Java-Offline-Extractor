function createBistuCrypto() {
    'use strict';
    /* BISTU_NOBLE_BUNDLE */
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
