import { z } from 'npm:zod@3.25.76';

export const AssessOut = z.object({
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  likelyIssue: z.string().min(1).max(120),
  reason: z.string().min(1).max(280),
  contactBuyer: z.boolean(),
});
export type AssessOut = z.infer<typeof AssessOut>;

export const ProposeOut = z.object({
  options: z.array(z.object({
    type: z.enum(['NEW_ETA', 'RESHIP', 'PARTIAL_REFUND', 'FULL_REFUND']),
    amountCents: z.number().int().nullish(),
    newEta: z.string().nullish(),
    rationale: z.string().max(200),
  })).min(1).max(3),
});
export type ProposeOut = z.infer<typeof ProposeOut>;

export const MessageOut = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(1).max(1500),
  mentionedAmountsCents: z.array(z.number().int()),
  mentionedDates: z.array(z.string()),
});
export type MessageOut = z.infer<typeof MessageOut>;

export const InterpretOut = z.object({
  choice: z.number().int().nullable(),
  wantsMore: z.boolean(),
  sentiment: z.enum(['CALM', 'UPSET', 'ANGRY']),
  summary: z.string().max(300),
});
export type InterpretOut = z.infer<typeof InterpretOut>;
