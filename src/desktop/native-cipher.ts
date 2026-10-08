import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCipher } from './vault.js';

/** The key arrives over inherited pipes from Rust's Keychain, never argv/env/files. */
export function nativeCipher(key: Buffer): SecretCipher {
  if (key.length !== 32) throw new Error('安全存储密钥不可用');
  const context = Buffer.from('CodexConnector/native/v1');
  return {
    encrypt(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(context);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `native:v1:${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64')}`;
    },
    decrypt(value) {
      try {
        if (!value.startsWith('native:v1:')) throw new Error('format');
        const bytes = Buffer.from(value.slice('native:v1:'.length), 'base64');
        if (bytes.length < 28) throw new Error('format');
        const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAAD(context);
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
      } catch {
        throw new Error('无法解密 Secret，请重新授权 Keychain 或重新填写');
      }
    },
  };
}
