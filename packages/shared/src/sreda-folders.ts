import { z } from 'zod';

export const SREDA_FOLDER_NAME_MAX_LENGTH = 100;
export const SREDA_FOLDER_NAME_FORBIDDEN = /[\/\\\u0000-\u001f\u007f]/u;

export const sredaFolderNameSchema = z
  .string()
  .trim()
  .min(1, 'folder_name_required')
  .max(SREDA_FOLDER_NAME_MAX_LENGTH, 'folder_name_too_long')
  .refine((name) => !SREDA_FOLDER_NAME_FORBIDDEN.test(name), 'folder_name_invalid_characters')
  .refine((name) => name !== '.' && name !== '..', 'folder_name_reserved');

export const sredaFolderCreateSchema = z
  .object({
    name: sredaFolderNameSchema,
    parentId: z.string().min(1).nullable().optional(),
  })
  .strict();

export const sredaFolderPatchSchema = z
  .object({
    name: sredaFolderNameSchema.optional(),
    parentId: z.string().min(1).nullable().optional(),
    ord: z.number().int().min(0).optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (body) => body.name !== undefined || body.parentId !== undefined || body.ord !== undefined,
    'folder_patch_empty',
  );

export function validateSredaFolderName(
  value: string,
): { ok: true; name: string } | { ok: false; message: string } {
  const parsed = sredaFolderNameSchema.safeParse(value);
  if (parsed.success) return { ok: true, name: parsed.data };
  const issue = parsed.error.issues[0]?.message;
  if (issue === 'folder_name_required') return { ok: false, message: 'Введите название папки' };
  if (issue === 'folder_name_too_long') {
    return {
      ok: false,
      message: `Не больше ${SREDA_FOLDER_NAME_MAX_LENGTH} символов`,
    };
  }
  if (issue === 'folder_name_reserved') {
    return { ok: false, message: 'Это название зарезервировано' };
  }
  return { ok: false, message: 'Название не может содержать /, \\ или управляющие символы' };
}

export interface SredaFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  ord: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  count: number;
  childCount: number;
}
