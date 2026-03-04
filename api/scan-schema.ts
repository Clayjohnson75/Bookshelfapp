import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Book spine schema for Gemini structured output.
 * Fields optional to avoid "required hallucination" - model may omit when unsure.
 */
export const BookSchema = z.object({
  title: z.string().min(1).describe('The book title (usually larger text on spine)'),
  author: z.string().optional().describe('Author name (usually smaller text)'),
  confidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Confidence in the detection'),
  spine_text: z.string().optional().describe('Raw text as seen on spine'),
  language: z
    .enum(['en', 'es', 'fr', 'unknown'])
    .optional()
    .describe('Detected language'),
  reason: z.string().optional().describe('Brief reason for confidence'),
  spine_index: z.number().int().min(0).optional().describe('Left-to-right order (0, 1, 2...)'),
});

/** Root: array of books (Gemini structured output works better with array-at-root than { books: [...] }) */
export const ScanResultSchema = z.array(BookSchema).max(200);

/** Minimal schema for tile scans (fewer fields = less truncation risk) */
export const TileBookSchema = z.object({
  title: z.string().min(1),
  author: z.string().optional(),
  isbn: z.string().optional(),
  spine_text: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  tile_index: z.number().int().min(0).optional(),
  spine_index_in_tile: z.number().int().min(0).optional(),
});
export const TileScanResultSchema = z.array(TileBookSchema).max(60);

export type ScanResult = z.infer<typeof ScanResultSchema>;
export type BookFromScan = z.infer<typeof BookSchema>;
export type TileBookFromScan = z.infer<typeof TileBookSchema>;

/** JSON schema for generationConfig.responseJsonSchema (Gemini REST API) */
export function getScanResultJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ScanResultSchema, {
    $refStrategy: 'none',
  });
  return schema as Record<string, unknown>;
}

/** JSON schema for tile scans (smaller output) */
export function getTileScanResultJsonSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(TileScanResultSchema, { $refStrategy: 'none' });
  return schema as Record<string, unknown>;
}
