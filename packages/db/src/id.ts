import { customAlphabet } from 'nanoid';

// 21-char URL-safe nanoid (default alphabet).
export const nid = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-',
  21,
);
